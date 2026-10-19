# Databricks Bundle Job Generator

A React + TypeScript wizard backed by FastAPI. It creates a `databricks.yml` bundle definition and `resources/jobs.yml` job resource. Generation does not contact Databricks and does not require credentials.

## Requirements

- Python 3.10 or newer
- Node.js 20 or newer with npm

Install the declared dependencies in your own development environment:

```sh
python -m pip install -r requirements.txt
npm install
```

## Run locally

Start the API from the project root:

```sh
python -m uvicorn backend.main:app --reload --port 8000
```

In a second terminal, start the React development server:

```sh
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`). Vite proxies `/api` requests to the local FastAPI server. The API health endpoint is `http://127.0.0.1:8000/api/health`.

FastAPI's interactive API documentation is at `http://127.0.0.1:8000/docs` (not `/swagger`). The API server does not serve the React UI at `/`; open the Vite URL instead. Invalid generation requests return HTTP 422 with field paths and validation messages, without echoing submitted values.

## Generated bundle files

The generator returns two temporary, token-protected download links. Each link expires five minutes after generation; temporary files are removed on expiry, periodically, and when a later app start finds expired output. Sensitive variable defaults and target overrides are excluded from both YAML files. The app does not request or store workspace credentials.

The browser downloads `jobs.yml` as a standalone file and does not preserve directory paths. For a valid bundle layout, place it under a `resources/` directory beside `databricks.yml`, so the final path is `resources/jobs.yml`. The `include` entry in `databricks.yml` points to that exact path.

Predefined node types and Runtime choices are examples, not a complete catalog or live availability data. Update `src/catalog.ts` to customize those lists.

If the Databricks CLI is installed, place `databricks.yml` in the bundle directory and `jobs.yml` under its `resources/` directory, then validate a target with:

```sh
databricks bundle validate -t dev
```

Replace `dev` with a target name from the generated `databricks.yml`. The CLI command is optional; it is not part of file generation.
