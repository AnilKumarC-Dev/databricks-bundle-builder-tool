from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


KEY_PATTERN = r"^[A-Za-z_][A-Za-z0-9_-]{0,99}$"
VARIABLE_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,99}$"


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VariableModel(RequestModel):
    name: str = Field(pattern=VARIABLE_PATTERN)
    description: str = Field(min_length=1, max_length=500)
    default_value: str = Field(max_length=10000)
    sensitive: bool


class ClusterModel(RequestModel):
    key: str = Field(pattern=KEY_PATTERN)
    cloud: Literal["AWS", "Azure", "GCP"]
    spark_version: str = Field(min_length=1, max_length=100)
    node_type_id: str = Field(min_length=1, max_length=100)
    scaling_mode: Literal["autoscaling", "fixed"]
    min_workers: int = Field(ge=0, le=1000)
    max_workers: int = Field(ge=1, le=1000)
    num_workers: int = Field(ge=1, le=1000)
    policy_id: str = Field(max_length=200)
    spark_conf: dict[str, str]

    @model_validator(mode="after")
    def validate_scaling(self) -> ClusterModel:
        if not self.spark_version.strip() or not self.node_type_id.strip():
            raise ValueError("Cluster runtime and node type are required.")
        if self.scaling_mode == "autoscaling" and self.min_workers > self.max_workers:
            raise ValueError("Cluster minimum workers cannot exceed maximum workers.")
        return self


class TargetVariableModel(RequestModel):
    variable_name: str = Field(pattern=VARIABLE_PATTERN)
    override_value: str = Field(max_length=10000)


class TargetModel(RequestModel):
    name: str = Field(pattern=KEY_PATTERN)
    workspace_url: str = Field(min_length=1, max_length=2048)
    root_path: str = Field(min_length=1, max_length=2048)
    variables: list[TargetVariableModel] = Field(max_length=100)

    @field_validator("workspace_url")
    @classmethod
    def validate_workspace_url(cls, value: str) -> str:
        try:
            parsed = urlsplit(value)
            hostname = parsed.hostname
            parsed.port
        except ValueError as error:
            raise ValueError("Enter a valid HTTPS workspace URL.") from error
        if (
            parsed.scheme != "https"
            or not hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            raise ValueError("Enter an HTTPS workspace URL without credentials, path, query, or fragment.")
        return value.rstrip("/")

    @field_validator("root_path")
    @classmethod
    def validate_root_path(cls, value: str) -> str:
        if not value.startswith("/") or any(character in value for character in ("\n", "\r", "\x00")):
            raise ValueError("Workspace root path must be an absolute path.")
        return value


class ParameterModel(RequestModel):
    key: str = Field(min_length=1, max_length=102)
    value: str = Field(max_length=10000)
    variable_name: str | None

    @field_validator("key", mode="before")
    @classmethod
    def normalize_key(cls, value: object) -> object:
        if isinstance(value, str) and value.startswith("--"):
            return value[2:]
        return value

    @field_validator("key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        if not re.fullmatch(KEY_PATTERN, value):
            raise ValueError("Enter a parameter name with letters, numbers, underscores, or hyphens.")
        return value


class TaskModel(RequestModel):
    task_key: str = Field(pattern=KEY_PATTERN)
    source: Literal["WORKSPACE", "GIT"]
    git_url: str = Field(max_length=2048)
    git_provider: Literal[
        "gitHub",
        "gitHubEnterprise",
        "gitLab",
        "gitLabEnterpriseEdition",
        "bitbucketCloud",
        "bitbucketServer",
        "azureDevOpsServices",
    ]
    git_ref_type: Literal["branch", "tag", "commit"]
    git_ref: str = Field(max_length=500)
    path: str = Field(min_length=1, max_length=2048)
    file_type: Literal["Python", "Notebook"]
    cluster_key: str = Field(pattern=KEY_PATTERN)
    parameters: list[ParameterModel] = Field(max_length=100)

    @model_validator(mode="after")
    def validate_source_fields(self) -> TaskModel:
        if "\n" in self.path or "\r" in self.path or "\x00" in self.path:
            raise ValueError("Task paths cannot contain control characters.")
        if self.source == "GIT":
            try:
                parsed = urlsplit(self.git_url)
                hostname = parsed.hostname
                parsed.port
            except ValueError as error:
                raise ValueError("Enter a valid Git repository URL.") from error
            if (
                parsed.scheme not in ("https", "ssh")
                or not hostname
                or not parsed.path.strip("/")
                or parsed.username and parsed.scheme == "https"
                or parsed.password and parsed.scheme == "https"
                or parsed.query
                or parsed.fragment
                or not self.git_ref.strip()
            ):
                raise ValueError("Git tasks need a valid repository URL and a branch, tag, or commit.")
            if self.path.startswith("/") or ".." in self.path.split("/"):
                raise ValueError("Git task paths must be relative to the repository and cannot traverse directories.")
        elif not self.path.startswith("/"):
            raise ValueError("Workspace task paths must be absolute workspace paths.")
        return self


class JobModel(RequestModel):
    name: str = Field(min_length=1, max_length=200)
    task_count: int = Field(ge=1, le=100)
    description: str = Field(max_length=1000)
    max_concurrent_runs: int = Field(ge=1, le=1000)
    timeout_seconds: int = Field(ge=0, le=31536000)
    schedule_cron: str = Field(max_length=200)
    schedule_timezone: str = Field(min_length=1, max_length=100)
    tasks: list[TaskModel] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_task_count(self) -> JobModel:
        if self.task_count != len(self.tasks):
            raise ValueError("Task count must match the number of task definitions.")
        return self

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip() or any(character in value for character in ("\n", "\r", "\x00")):
            raise ValueError("Job name must contain visible text and cannot contain control characters.")
        return value

    @field_validator("schedule_cron")
    @classmethod
    def validate_cron(cls, value: str) -> str:
        value = value.strip()
        if value and (len(value.split()) not in (6, 7) or not re.fullmatch(r"[\w*/?,#LW\-]+(?:\s+[\w*/?,#LW\-]+){5,6}", value)):
            raise ValueError("Use a six- or seven-field Quartz cron expression.")
        return value


class BundleRequest(RequestModel):
    bundle_name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
    variables: list[VariableModel] = Field(max_length=100)
    clusters: list[ClusterModel] = Field(min_length=1, max_length=100)
    targets: list[TargetModel] = Field(min_length=1, max_length=100)
    job: JobModel

    @model_validator(mode="after")
    def validate_references(self) -> BundleRequest:
        variable_names = [item.name for item in self.variables]
        cluster_keys = [item.key for item in self.clusters]
        target_names = [item.name.lower() for item in self.targets]
        task_keys = [item.task_key for item in self.job.tasks]

        if len({name.lower() for name in variable_names}) != len(variable_names):
            raise ValueError("Variable names must be unique.")
        if len({key.lower() for key in cluster_keys}) != len(cluster_keys):
            raise ValueError("Cluster keys must be unique.")
        if len(set(target_names)) != len(target_names):
            raise ValueError("Target names must be unique.")
        if len({key.lower() for key in task_keys}) != len(task_keys):
            raise ValueError("Task keys must be unique.")

        known_variables = set(variable_names)
        known_clusters = set(cluster_keys)
        for target in self.targets:
            selected = [item.variable_name for item in target.variables]
            if len({name.lower() for name in selected}) != len(selected):
                raise ValueError(f"Target '{target.name}' contains a variable more than once.")
            if not set(selected).issubset(known_variables):
                raise ValueError(f"Target '{target.name}' references an undefined variable.")
        git_tasks = [task for task in self.job.tasks if task.source == "GIT"]
        if git_tasks:
            git_source = (git_tasks[0].git_url, git_tasks[0].git_provider, git_tasks[0].git_ref_type, git_tasks[0].git_ref)
            if any((task.git_url, task.git_provider, task.git_ref_type, task.git_ref) != git_source for task in git_tasks[1:]):
                raise ValueError("All Git tasks in a Databricks job must use the same repository, provider, and ref.")

        for task in self.job.tasks:
            if task.cluster_key not in known_clusters:
                raise ValueError(f"Task '{task.task_key}' references an undefined cluster.")
            parameter_keys = [parameter.key for parameter in task.parameters]
            if len({key.lower() for key in parameter_keys}) != len(parameter_keys):
                raise ValueError(f"Task '{task.task_key}' contains a parameter more than once.")
            if any(parameter.variable_name and parameter.variable_name not in known_variables for parameter in task.parameters):
                raise ValueError(f"Task '{task.task_key}' references an undefined variable.")
        return self
