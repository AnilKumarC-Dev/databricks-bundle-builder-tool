export type Variable = {
  name: string;
  description: string;
  default_value: string;
  sensitive: boolean;
};

export type Cluster = {
  key: string;
  cloud: string;
  spark_version: string;
  node_type_id: string;
  scaling_mode: "autoscaling" | "fixed";
  min_workers: number;
  max_workers: number;
  num_workers: number;
  policy_id: string;
  spark_conf_text: string;
};

export type TargetVariable = { variable_name: string; override_value: string };
export type Target = {
  name: string;
  workspace_url: string;
  root_path: string;
  variables: TargetVariable[];
};

export type Parameter = { key: string; value: string; variable_name: string };
export type Task = {
  task_key: string;
  source: "WORKSPACE" | "GIT";
  git_url: string;
  git_provider: string;
  git_ref_type: "branch" | "tag" | "commit";
  git_ref: string;
  path: string;
  file_type: "Python" | "Notebook";
  cluster_key: string;
  parameters: Parameter[];
};

export type BundleConfig = {
  bundle_name: string;
  variables: Variable[];
  clusters: Cluster[];
  targets: Target[];
  job_name: string;
  task_count: number;
  tasks: Task[];
  description: string;
  max_concurrent_runs: number;
  timeout_seconds: number;
  schedule_cron: string;
  schedule_timezone: string;
};

export type GeneratedFiles = {
  expires_at: string;
  files: { name: string; url: string; path?: string }[];
};
