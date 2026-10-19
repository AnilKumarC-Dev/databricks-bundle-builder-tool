import type { BundleConfig, Cluster, Target, Task } from "./types";

export const emptyCluster = (): Cluster => ({
  key: "cluster_1",
  cloud: "AWS",
  spark_version: "15.4.x-scala2.12",
  node_type_id: "m5d.large",
  scaling_mode: "autoscaling",
  min_workers: 1,
  max_workers: 4,
  num_workers: 2,
  policy_id: "",
  spark_conf_text: "",
});

export const emptyTarget = (): Target => ({
  name: "",
  workspace_url: "",
  root_path: "/Workspace/Shared/.bundle/${bundle.name}/${bundle.target}",
  variables: [],
});

export const emptyTask = (index = 0): Task => ({
  task_key: `task_${index + 1}`,
  source: "WORKSPACE",
  git_url: "",
  git_provider: "gitHub",
  git_ref_type: "branch",
  git_ref: "main",
  path: "",
  file_type: "Python",
  cluster_key: "cluster_1",
  parameters: [],
});

export const initialConfig: BundleConfig = {
  bundle_name: "",
  variables: [],
  clusters: [emptyCluster()],
  targets: [emptyTarget()],
  job_name: "",
  task_count: 1,
  tasks: [emptyTask()],
  description: "",
  max_concurrent_runs: 1,
  timeout_seconds: 0,
  schedule_cron: "",
  schedule_timezone: "UTC",
};
