from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .models import BundleRequest, ClusterModel, ParameterModel, TaskModel


logger = logging.getLogger("bundle_generator")
TOKEN_TTL_SECONDS = 5 * 60
TEMP_PREFIX = "databricks-bundle-generator-"
DOWNLOAD_ROOT = Path(tempfile.gettempdir())
JOBS_RESOURCE_PATH = Path("resources") / "jobs.yml"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False) -> Any:
        return super().increase_indent(flow, False)


@dataclass
class GeneratedBundle:
    directory: Path
    expires_at: float


downloads: dict[str, GeneratedBundle] = {}


def _remove_directory(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return
    except OSError:
        logger.exception("Could not remove temporary bundle directory %s", path)


def _clean_expired_directories(now: float) -> None:
    for candidate in DOWNLOAD_ROOT.glob(f"{TEMP_PREFIX}*"):
        if not candidate.is_dir():
            continue
        try:
            if candidate.stat().st_mtime + TOKEN_TTL_SECONDS <= now:
                _remove_directory(candidate)
        except OSError:
            logger.exception("Could not inspect temporary bundle directory %s", candidate)


def _cleanup_downloads(now: float) -> None:
    expired = [token for token, entry in downloads.items() if entry.expires_at <= now]
    for token in expired:
        entry = downloads.pop(token)
        _remove_directory(entry.directory)
    _clean_expired_directories(now)


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(30)
        _cleanup_downloads(time.time())


@asynccontextmanager
async def lifespan(_: FastAPI):
    _cleanup_downloads(time.time())
    cleanup_task = asyncio.create_task(_cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Databricks Bundle Job Generator", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def request_validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
    details = [
        {
            "loc": list(item.get("loc", ())),
            "msg": item.get("msg", "Invalid value."),
            "type": item.get("type", "value_error"),
        }
        for item in error.errors()
    ]
    logger.warning(
        "Rejected invalid bundle generation request: %s",
        [item["loc"] for item in details],
    )
    return JSONResponse(status_code=422, content={"detail": details})


def _cluster_yaml(cluster: ClusterModel) -> dict[str, Any]:
    result: dict[str, Any] = {
        "job_cluster_key": cluster.key,
        "new_cluster": {
            "spark_version": cluster.spark_version,
            "node_type_id": cluster.node_type_id,
        },
    }
    new_cluster = result["new_cluster"]
    if cluster.scaling_mode == "autoscaling":
        new_cluster["autoscale"] = {
            "min_workers": cluster.min_workers,
            "max_workers": cluster.max_workers,
        }
    else:
        new_cluster["num_workers"] = cluster.num_workers
    if cluster.policy_id:
        new_cluster["policy_id"] = cluster.policy_id
    if cluster.spark_conf:
        new_cluster["spark_conf"] = cluster.spark_conf
    return result


def _task_yaml(task: TaskModel) -> dict[str, Any]:
    task_config: dict[str, Any] = {
        "task_key": task.task_key,
        "job_cluster_key": task.cluster_key,
        "source": task.source,
    }

    def parameter_value(item: ParameterModel) -> str:
        return f"${{var.{item.variable_name}}}" if item.variable_name else item.value

    if task.file_type == "Python":
        task_config["spark_python_task"] = {
            "python_file": task.path,
            "parameters": [
                argument
                for item in task.parameters
                for argument in (f"--{item.key}", parameter_value(item))
            ],
        }
    else:
        task_config["notebook_task"] = {
            "notebook_path": task.path,
            "base_parameters": {item.key: parameter_value(item) for item in task.parameters},
        }
    return task_config


def build_yaml_documents(request: BundleRequest) -> tuple[dict[str, Any], dict[str, Any]]:
    variables: dict[str, Any] = {}
    variable_models = {item.name: item for item in request.variables}
    for variable in request.variables:
        definition: dict[str, Any] = {"description": variable.description}
        if not variable.sensitive:
            definition["default"] = variable.default_value
        variables[variable.name] = definition

    targets: dict[str, Any] = {}
    for target in request.targets:
        target_variables = {
            selected.variable_name: selected.override_value
            for selected in target.variables
            if not variable_models[selected.variable_name].sensitive and selected.override_value != ""
        }
        target_definition: dict[str, Any] = {
            "workspace": {"host": target.workspace_url, "root_path": target.root_path}
        }
        if target_variables:
            target_definition["variables"] = target_variables
        targets[target.name] = target_definition

    bundle_document = {
        "bundle": {"name": request.bundle_name},
        "include": [JOBS_RESOURCE_PATH.as_posix()],
        "variables": variables,
        "targets": targets,
    }

    git_tasks = [task for task in request.job.tasks if task.source == "GIT"]
    job: dict[str, Any] = {
        "name": request.job.name,
        "max_concurrent_runs": request.job.max_concurrent_runs,
        "job_clusters": [_cluster_yaml(cluster) for cluster in request.clusters],
        "tasks": [_task_yaml(task) for task in request.job.tasks],
    }
    if request.job.description:
        job["description"] = request.job.description
    if request.job.timeout_seconds:
        job["timeout_seconds"] = request.job.timeout_seconds
    if request.job.schedule_cron:
        job["schedule"] = {
            "quartz_cron_expression": request.job.schedule_cron,
            "timezone_id": request.job.schedule_timezone,
            "pause_status": "UNPAUSED",
        }
    if git_tasks:
        task = git_tasks[0]
        job["git_source"] = {
            "git_url": task.git_url,
            "git_provider": task.git_provider,
            f"git_{task.git_ref_type}": task.git_ref,
        }

    jobs_document = {"resources": {"jobs": {"generated_job": job}}}
    return bundle_document, jobs_document


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/generate")
async def generate(request: BundleRequest) -> dict[str, Any]:
    bundle_document, jobs_document = build_yaml_documents(request)
    directory = Path(tempfile.mkdtemp(prefix=TEMP_PREFIX))
    try:
        (directory / JOBS_RESOURCE_PATH).parent.mkdir()
        (directory / "databricks.yml").write_text(
            yaml.dump(
                bundle_document,
                Dumper=IndentedSafeDumper,
                sort_keys=False,
                allow_unicode=True,
                default_flow_style=False,
            ),
            encoding="utf-8",
        )
        (directory / JOBS_RESOURCE_PATH).write_text(
            yaml.dump(
                jobs_document,
                Dumper=IndentedSafeDumper,
                sort_keys=False,
                allow_unicode=True,
                default_flow_style=False,
            ),
            encoding="utf-8",
        )
    except OSError as error:
        _remove_directory(directory)
        logger.exception("Could not write generated bundle files")
        raise HTTPException(status_code=500, detail="Could not write the generated bundle files.") from error

    now = time.time()
    _cleanup_downloads(now)
    token = secrets.token_urlsafe(32)
    expires_at = now + TOKEN_TTL_SECONDS
    downloads[token] = GeneratedBundle(directory=directory, expires_at=expires_at)
    return {
        "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(),
        "files": [
            {"name": "databricks.yml", "url": f"/api/download/{token}/databricks.yml"},
            {"name": "resources/jobs.yml", "url": f"/api/download/{token}/jobs.yml"},
        ],
    }


@app.get("/api/download/{token}/{filename}")
async def download(token: str, filename: str):
    if filename not in {"databricks.yml", "jobs.yml"}:
        raise HTTPException(status_code=404, detail="File not found.")
    entry = downloads.get(token)
    if entry is None:
        raise HTTPException(status_code=410, detail="This download link has expired. Generate the bundle again.")
    if entry.expires_at <= time.time():
        downloads.pop(token, None)
        _remove_directory(entry.directory)
        raise HTTPException(status_code=410, detail="This download link has expired. Generate the bundle again.")
    path = entry.directory / ("databricks.yml" if filename == "databricks.yml" else JOBS_RESOURCE_PATH)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Generated file not found.")
    return FileResponse(path, filename=filename, media_type="application/yaml")
