import { Children, cloneElement, isValidElement, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { nodeTypeOptions, providers, runtimeOptions } from "./catalog";
import { emptyCluster, emptyTarget, emptyTask, initialConfig } from "./defaults";
import type {
  BundleConfig,
  Cluster,
  GeneratedFiles,
  Parameter,
  Target,
  Task,
  Variable,
} from "./types";

const steps = ["Bundle & clusters", "Targets", "Job & tasks", "Review & generate"];
const validKey = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const validParameterKey = /^(?:--)?[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const validVariable = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const normalizeParameterKey = (key: string) => key.startsWith("--") ? key.slice(2) : key;

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  let controlIdAssigned = false;
  const labeledChildren = Children.map(children, (child) => {
    if (!isValidElement<{
      id?: string;
      role?: string;
      "aria-labelledby"?: string;
      "aria-invalid"?: boolean;
      "aria-describedby"?: string;
    }>(child) || typeof child.type !== "string") {
      return child;
    }
    if (["input", "select", "textarea"].includes(child.type)) {
      const id = !controlIdAssigned && !child.props.id ? fieldId : child.props.id;
      controlIdAssigned = true;
      return cloneElement(child, {
        ...(id ? { id } : {}),
        ...(error ? { "aria-invalid": true } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      });
    }
    if (child.type === "div") {
      return cloneElement(child, {
        role: "group",
        "aria-labelledby": `${fieldId}-label`,
        ...(error ? { "aria-invalid": true } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      });
    }
    return child;
  });
  return (
    <div className={`field${error ? " field-invalid" : ""}`}>
      <label className="field-label" id={`${fieldId}-label`} htmlFor={fieldId}>{label}</label>
      {labeledChildren}
      {hint && <small className="field-hint" id={hintId}>{hint}</small>}
      {error && <small className="field-error" id={errorId} role="alert">{error}</small>}
    </div>
  );
}

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="field-error" role="alert">{message}</p> : null;
}

function App() {
  const [config, setConfig] = useState<BundleConfig>(() => structuredClone(initialConfig));
  const [screen, setScreen] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generationError, setGenerationError] = useState("");
  const [generated, setGenerated] = useState<GeneratedFiles | null>(null);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");
  const [downloadError, setDownloadError] = useState(false);
  const variables = config.variables;

  const update = <K extends keyof BundleConfig>(key: K, value: BundleConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setGenerated(null);
    setGenerationError("");
  };

  const variableOptions = useMemo(
    () => variables.map((variable) => variable.name).filter(Boolean),
    [variables],
  );

  function setVariable(index: number, patch: Partial<Variable>) {
    const previousName = config.variables[index]?.name;
    const nextName = patch.name;
    const next = config.variables.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    update("variables", next);
    if (nextName !== undefined && previousName && nextName !== previousName) {
      update("targets", config.targets.map((target) => ({
        ...target,
        variables: target.variables.map((item) => item.variable_name === previousName
          ? { ...item, variable_name: nextName }
          : item),
      })));
      update("tasks", config.tasks.map((task) => ({
        ...task,
        parameters: task.parameters.map((item) => item.variable_name === previousName
          ? { ...item, variable_name: nextName }
          : item),
      })));
    }
  }

  function removeVariable(index: number) {
    const removed = config.variables[index]?.name;
    update("variables", config.variables.filter((_, itemIndex) => itemIndex !== index));
    if (removed) {
      update("targets", config.targets.map((target) => ({
        ...target,
        variables: target.variables.filter((item) => item.variable_name !== removed),
      })));
      update("tasks", config.tasks.map((task) => ({
        ...task,
        parameters: task.parameters.map((parameter) =>
          parameter.variable_name === removed ? { ...parameter, variable_name: "" } : parameter),
      })));
    }
  }

  function setCluster(index: number, patch: Partial<Cluster>) {
    const previousKey = config.clusters[index]?.key;
    const nextKey = patch.key;
    update("clusters", config.clusters.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
    if (nextKey !== undefined && previousKey !== nextKey) {
      update("tasks", config.tasks.map((task) => task.cluster_key === previousKey ? { ...task, cluster_key: nextKey } : task));
    }
  }

  function removeCluster(index: number) {
    const remaining = config.clusters.filter((_, itemIndex) => itemIndex !== index);
    update("clusters", remaining);
    if (remaining.length) {
      update("tasks", config.tasks.map((task) =>
        task.cluster_key === config.clusters[index]?.key
          ? { ...task, cluster_key: remaining[0].key }
          : task));
    }
  }

  function setTarget(index: number, patch: Partial<Target>) {
    update("targets", config.targets.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function toggleTargetVariable(targetIndex: number, name: string, selected: boolean) {
    const target = config.targets[targetIndex];
    if (!target) return;
    const current = target.variables.filter((item) => item.variable_name !== name);
    const next = selected ? [...current, { variable_name: name, override_value: "" }] : current;
    setTarget(targetIndex, { variables: next });
  }

  function setTask(index: number, patch: Partial<Task>) {
    update("tasks", config.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function setParameter(taskIndex: number, paramIndex: number, patch: Partial<Parameter>) {
    const task = config.tasks[taskIndex];
    if (!task) return;
    setTask(taskIndex, {
      parameters: task.parameters.map((item, itemIndex) => itemIndex === paramIndex ? { ...item, ...patch } : item),
    });
  }

  function validateScreen(index: number): Record<string, string> {
    const found: Record<string, string> = {};
    const add = (key: string, message: string) => { found[key] = message; };
    const unique = (items: string[]) => new Set(items.map((item) => item.trim().toLowerCase())).size === items.length;
    if (index === 0) {
      if (!config.bundle_name.trim()) add("bundle_name", "Enter a bundle name.");
      else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(config.bundle_name)) add("bundle_name", "Use letters, numbers, hyphens, or underscores; start with a letter or number.");
      config.variables.forEach((item, i) => {
        if (!item.name.trim()) add(`variable-${i}-name`, "Enter a variable name.");
        else if (!validVariable.test(item.name)) add(`variable-${i}-name`, "Use a valid variable identifier (letters, numbers, and underscores).");
        if (!item.description.trim()) add(`variable-${i}-description`, "Enter a description.");
      });
      if (!unique(config.variables.map((item) => item.name))) add("variables", "Variable names must be unique.");
      if (!config.clusters.length) add("clusters", "Add at least one cluster.");
      config.clusters.forEach((cluster, i) => {
        if (!cluster.key.trim()) add(`cluster-${i}-key`, "Enter a cluster key.");
        else if (!validKey.test(cluster.key)) add(`cluster-${i}-key`, "Use letters, numbers, underscores, or hyphens; start with a letter or underscore.");
        if (!cluster.spark_version.trim()) add(`cluster-${i}-runtime`, "Choose or enter a runtime.");
        if (!cluster.node_type_id.trim()) add(`cluster-${i}-node`, "Choose or enter a node type.");
        if (cluster.scaling_mode === "autoscaling") {
          if (!Number.isInteger(cluster.min_workers) || !Number.isInteger(cluster.max_workers) || cluster.min_workers < 0 || cluster.max_workers < 1) add(`cluster-${i}-workers`, "Worker counts must be valid positive values.");
          else if (cluster.min_workers > cluster.max_workers) add(`cluster-${i}-workers`, "Minimum workers cannot exceed maximum workers.");
        } else if (!Number.isInteger(cluster.num_workers) || cluster.num_workers < 1) add(`cluster-${i}-workers`, "Fixed worker count must be at least one.");
        const malformedSparkConf = cluster.spark_conf_text.split(/\r?\n/).some((line) => {
          if (!line.trim()) return false;
          const separator = line.indexOf("=");
          return separator < 1 || !line.slice(0, separator).trim();
        });
        if (malformedSparkConf) add(`cluster-${i}-spark-conf`, "Use one key=value pair per line.");
      });
      if (!unique(config.clusters.map((item) => item.key))) add("clusters", "Cluster keys must be unique.");
    }
    if (index === 1) {
      if (!config.targets.length) add("targets", "Add at least one deployment target.");
      config.targets.forEach((target, i) => {
        if (!target.name.trim()) add(`target-${i}-name`, "Enter a target name.");
        else if (!validKey.test(target.name)) add(`target-${i}-name`, "Use a valid target key.");
        if (!target.workspace_url.trim()) add(`target-${i}-url`, "Enter a workspace URL.");
        else {
          try {
            const url = new URL(target.workspace_url);
            if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
              add(`target-${i}-url`, "Enter a valid HTTPS workspace URL without credentials, query, or fragment.");
            }
          } catch {
            add(`target-${i}-url`, "Enter a valid HTTPS workspace URL.");
          }
        }
        if (!target.root_path.trim() || !target.root_path.startsWith("/")) add(`target-${i}-root`, "Enter an absolute workspace root path.");
        if (!unique(target.variables.map((item) => item.variable_name))) add(`target-${i}-variables`, "Each variable can be selected only once.");
      });
      if (!unique(config.targets.map((item) => item.name))) add("targets", "Target names must be unique.");
    }
    if (index === 2) {
      if (!config.job_name.trim()) add("job_name", "Enter a job name.");
      if (!Number.isInteger(config.max_concurrent_runs) || config.max_concurrent_runs < 1 || config.max_concurrent_runs > 1000) add("max_concurrent_runs", "Enter a whole number between 1 and 1000.");
      if (!Number.isInteger(config.timeout_seconds) || config.timeout_seconds < 0 || config.timeout_seconds > 31536000) add("timeout_seconds", "Enter a whole number between 0 and 31536000.");
      if (!config.schedule_timezone.trim()) add("schedule_timezone", "Enter a timezone, such as UTC.");
      if (!config.tasks.length) add("tasks", "Add at least one task.");
      config.tasks.forEach((task, i) => {
        if (!task.task_key.trim()) add(`task-${i}-key`, "Enter a task key.");
        else if (!validKey.test(task.task_key)) add(`task-${i}-key`, "Use a valid task key.");
        if (!task.path.trim()) add(`task-${i}-path`, "Enter the source file path.");
        else if (task.source === "WORKSPACE" && !task.path.startsWith("/")) add(`task-${i}-path`, "Workspace paths must be absolute.");
        else if (task.source === "GIT" && (task.path.startsWith("/") || task.path.split("/").includes(".."))) add(`task-${i}-path`, "Git paths must be relative and cannot traverse directories.");
        if (task.source === "GIT") {
          if (!task.git_url.trim()) add(`task-${i}-git-url`, "Enter the Git repository URL.");
          else {
            try {
              const gitUrl = new URL(task.git_url);
              if (!["https:", "ssh:"].includes(gitUrl.protocol) || !gitUrl.hostname || !gitUrl.pathname.trim().replaceAll("/", "") || gitUrl.search || gitUrl.hash || (gitUrl.protocol === "https:" && (gitUrl.username || gitUrl.password))) {
                add(`task-${i}-git-url`, "Enter an HTTPS or SSH repository URL.");
              }
            } catch {
              add(`task-${i}-git-url`, "Enter an HTTPS or SSH repository URL.");
            }
          }
          if (!task.git_ref.trim()) add(`task-${i}-git-ref`, `Enter a Git ${task.git_ref_type}.`);
        }
        if (!task.cluster_key || !config.clusters.some((cluster) => cluster.key === task.cluster_key)) add(`task-${i}-cluster`, "Select a defined cluster.");
        task.parameters.forEach((parameter, p) => {
          if (!parameter.key.trim()) add(`task-${i}-param-${p}-key`, "Enter a parameter key.");
          else if (!validParameterKey.test(parameter.key)) add(`task-${i}-param-${p}-key`, "Enter a parameter name with optional leading --.");
          if (parameter.variable_name && !variableOptions.includes(parameter.variable_name)) add(`task-${i}-param-${p}-variable`, "Select a defined variable.");
        });
        if (!unique(task.parameters.map((item) => normalizeParameterKey(item.key)))) add(`task-${i}-parameters`, "Parameter keys must be unique within a task.");
      });
      if (!unique(config.tasks.map((item) => item.task_key))) add("tasks", "Task keys must be unique.");
      const gitTasks = config.tasks.filter((task) => task.source === "GIT");
      if (gitTasks.length > 1) {
        const source = JSON.stringify([gitTasks[0].git_url, gitTasks[0].git_provider, gitTasks[0].git_ref_type, gitTasks[0].git_ref]);
        if (gitTasks.some((task) => JSON.stringify([task.git_url, task.git_provider, task.git_ref_type, task.git_ref]) !== source)) {
          add("git-source", "Databricks jobs use one Git source. Configure identical repository, provider, and ref for every Git task.");
        }
      }
      if (config.schedule_cron.trim() && config.schedule_cron.trim().split(/\s+/).length !== 6 && config.schedule_cron.trim().split(/\s+/).length !== 7) {
        add("schedule_cron", "Enter a six- or seven-field Quartz cron expression.");
      }
    }
    return found;
  }

  function next() {
    const currentErrors = validateScreen(screen);
    setErrors(currentErrors);
    if (Object.keys(currentErrors).length) {
      document.querySelector(".field-error")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setScreen(Math.min(3, screen + 1));
    setErrors({});
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goTo(index: number) {
    if (index <= screen) {
      setScreen(index);
      setErrors({});
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function generate() {
    const allErrors = [0, 1, 2].flatMap((index) => Object.entries(validateScreen(index)));
    if (allErrors.length) {
      const key = allErrors[0][0];
      const targetScreen = key.startsWith("target") ? 1 : key.startsWith("task") || key === "tasks" || key.startsWith("git-") || key === "job_name" || key.startsWith("schedule") ? 2 : 0;
      setScreen(targetScreen);
      setErrors(validateScreen(targetScreen));
      return;
    }
    setGenerating(true);
    setGenerationError("");
    setDownloadMessage("");
    setGenerated(null);
    try {
      const payload = {
        bundle_name: config.bundle_name,
        variables: config.variables,
        clusters: config.clusters.map((cluster) => {
          const spark_conf: Record<string, string> = {};
          for (const line of cluster.spark_conf_text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const separator = line.indexOf("=");
            if (separator < 1 || !line.slice(0, separator).trim()) throw new Error(`Invalid Spark configuration line: ${line}`);
            spark_conf[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
          }
          return {
            key: cluster.key,
            cloud: cluster.cloud,
            spark_version: cluster.spark_version,
            node_type_id: cluster.node_type_id,
            scaling_mode: cluster.scaling_mode,
            min_workers: cluster.min_workers,
            max_workers: cluster.max_workers,
            num_workers: cluster.num_workers,
            policy_id: cluster.policy_id,
            spark_conf,
          };
        }),
        targets: config.targets,
        job: {
          name: config.job_name,
          task_count: config.task_count,
          description: config.description,
          max_concurrent_runs: config.max_concurrent_runs,
          timeout_seconds: config.timeout_seconds,
          schedule_cron: config.schedule_cron,
          schedule_timezone: config.schedule_timezone,
          tasks: config.tasks,
        },
      };
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = Array.isArray(body.detail)
          ? body.detail.map((item: { loc?: (string | number)[]; msg?: string }) =>
              `${item.loc?.filter((part) => part !== "body").join(".") || "Configuration"}: ${item.msg ?? "Invalid value"}`).join("; ")
          : body.detail;
        throw new Error(detail || `Generation failed (${response.status}).`);
      }
      setGenerated(await response.json() as GeneratedFiles);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "An unexpected error prevented generation.");
    } finally {
      setGenerating(false);
    }
  }

  async function downloadFile(url: string) {
    const fileName = url.endsWith("jobs.yml") ? "resources/jobs.yml" : "databricks.yml";
    setDownloading(fileName);
    setDownloadMessage("");
    setDownloadError(false);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || "The download could not be completed.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = url.endsWith("jobs.yml") ? "jobs.yml" : "databricks.yml";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setDownloadMessage(`${fileName} downloaded.`);
    } catch (error) {
      setDownloadMessage(error instanceof Error ? error.message : "The download could not be completed.");
      setDownloadError(true);
    } finally {
      setDownloading("");
    }
  }

  const stepOne = (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">01 / FOUNDATION</p><h2>Bundle and variables</h2></div>
          <span className="step-icon">01</span>
        </div>
        <Field label="Bundle name" error={errors.bundle_name} hint="A stable identifier used by Databricks Asset Bundles.">
          <input value={config.bundle_name} onChange={(event) => update("bundle_name", event.target.value)} placeholder="customer-insights" aria-invalid={!!errors.bundle_name} />
        </Field>
        <div className="section-divider">
          <div className="subheading"><div><h3>Variables</h3><p>Values are configurable per target. Sensitive values are never written to YAML.</p></div>
            <button type="button" className="button button-small" onClick={() => update("variables", [...variables, { name: "", description: "", default_value: "", sensitive: false }])}>＋ Add variable</button>
          </div>
          <ErrorText message={errors.variables} />
          {variables.length === 0 ? <div className="empty-state">No variables yet. Add one to reuse values across targets and tasks.</div> :
            variables.map((variable, index) => (
              <article className="item-card" key={`variable-${index}`}>
                <div className="item-title"><strong>Variable {index + 1}</strong><button type="button" className="text-button danger-text" aria-label={`Remove variable ${index + 1}`} onClick={() => removeVariable(index)}>Remove</button></div>
                <div className="grid two">
                  <Field label="Name" error={errors[`variable-${index}-name`]}><input value={variable.name} onChange={(event) => setVariable(index, { name: event.target.value })} placeholder="catalog_name" /></Field>
                  <Field label="Description" error={errors[`variable-${index}-description`]}><input value={variable.description} onChange={(event) => setVariable(index, { description: event.target.value })} placeholder="Catalog used by this job" /></Field>
                </div>
                <div className="grid two align-end">
                  <Field label="Default value" hint={variable.sensitive ? "Sensitive values are excluded from generated files." : undefined}>
                    <input type={variable.sensitive ? "password" : "text"} autoComplete="new-password" value={variable.default_value} onChange={(event) => setVariable(index, { default_value: event.target.value })} placeholder={variable.sensitive ? "Sensitive value" : "main"} />
                  </Field>
                  <label className="check-row"><input type="checkbox" checked={variable.sensitive} onChange={(event) => setVariable(index, { sensitive: event.target.checked })} /><span>Mark as sensitive</span></label>
                </div>
              </article>
            ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">COMPUTE</p><h2>Job clusters</h2></div>
          <button type="button" className="button button-small" onClick={() => {
            let suffix = config.clusters.length + 1;
            while (config.clusters.some((item) => item.key === `cluster_${suffix}`)) suffix += 1;
            update("clusters", [...config.clusters, { ...emptyCluster(), key: `cluster_${suffix}` }]);
          }}>＋ Add cluster</button>
        </div>
        <ErrorText message={errors.clusters} />
        {config.clusters.map((cluster, index) => {
          const nodes = nodeTypeOptions[cluster.cloud] ?? [];
          const runtimeCustom = !runtimeOptions.slice(0, -1).includes(cluster.spark_version);
          const nodeCustom = !nodes.slice(0, -1).includes(cluster.node_type_id);
          return (
            <article className="item-card" key={`cluster-${index}`}>
              <div className="item-title"><strong>Cluster {index + 1}</strong>{config.clusters.length > 1 && <button type="button" className="text-button danger-text" onClick={() => removeCluster(index)}>Remove</button>}</div>
              <div className="grid two">
                <Field label="Cluster key" error={errors[`cluster-${index}-key`]}><input value={cluster.key} onChange={(event) => setCluster(index, { key: event.target.value })} placeholder="default_cluster" /></Field>
                <Field label="Cloud" hint="Informational selector for node examples; the workspace determines the actual cloud."><select value={cluster.cloud} onChange={(event) => {
                  const cloud = event.target.value;
                  setCluster(index, { cloud, node_type_id: nodeTypeOptions[cloud].find((item) => item !== "Custom") ?? "" });
                }}><option>AWS</option><option>Azure</option><option>GCP</option></select></Field>
              </div>
              <div className="grid two">
                <Field label="Databricks Runtime / Spark" error={errors[`cluster-${index}-runtime`]} hint="Catalog examples only; verify current availability in your workspace.">
                  <select value={runtimeCustom ? "Custom" : cluster.spark_version} onChange={(event) => setCluster(index, { spark_version: event.target.value === "Custom" ? "" : event.target.value })}><option value="" disabled>Select a runtime</option>{runtimeOptions.map((item) => <option key={item}>{item}</option>)}</select>
                  {runtimeCustom && <input className="custom-input" aria-label="Custom runtime version" value={cluster.spark_version} onChange={(event) => setCluster(index, { spark_version: event.target.value })} placeholder="e.g. 16.4.x-scala2.12" />}
                </Field>
                <Field label="Node type" error={errors[`cluster-${index}-node`]} hint="Catalog examples only; not live availability data.">
                  <select value={nodeCustom ? "Custom" : cluster.node_type_id} onChange={(event) => setCluster(index, { node_type_id: event.target.value === "Custom" ? "" : event.target.value })}><option value="" disabled>Select a node type</option>{nodes.map((item) => <option key={item}>{item}</option>)}</select>
                  {nodeCustom && <input className="custom-input" aria-label="Custom node type ID" value={cluster.node_type_id} onChange={(event) => setCluster(index, { node_type_id: event.target.value })} placeholder="Enter a node type ID" />}
                </Field>
              </div>
              <Field label="Worker configuration" error={errors[`cluster-${index}-workers`]}>
                <div className="radio-row">
                  <label className="check-row"><input type="radio" name={`scale-${index}`} checked={cluster.scaling_mode === "autoscaling"} onChange={() => setCluster(index, { scaling_mode: "autoscaling" })} /><span>Autoscaling</span></label>
                  <label className="check-row"><input type="radio" name={`scale-${index}`} checked={cluster.scaling_mode === "fixed"} onChange={() => setCluster(index, { scaling_mode: "fixed" })} /><span>Fixed workers</span></label>
                </div>
                {cluster.scaling_mode === "autoscaling" ?
                  <div className="grid two compact-grid">
                    <Field label="Minimum workers"><input type="number" min="0" value={cluster.min_workers} onChange={(event) => setCluster(index, { min_workers: Number(event.target.value) })} /></Field>
                    <Field label="Maximum workers"><input type="number" min="1" value={cluster.max_workers} onChange={(event) => setCluster(index, { max_workers: Number(event.target.value) })} /></Field>
                  </div> :
                  <div className="short-field"><Field label="Worker count"><input type="number" min="1" value={cluster.num_workers} onChange={(event) => setCluster(index, { num_workers: Number(event.target.value) })} /></Field></div>}
              </Field>
              <div className="grid two">
                <Field label="Cluster policy ID (optional)"><input value={cluster.policy_id} onChange={(event) => setCluster(index, { policy_id: event.target.value })} placeholder="Policy ID" /></Field>
                <Field label="Spark configuration (optional)" error={errors[`cluster-${index}-spark-conf`]} hint="One key=value pair per line."><textarea rows={3} value={cluster.spark_conf_text} onChange={(event) => setCluster(index, { spark_conf_text: event.target.value })} placeholder={"spark.sql.shuffle.partitions=200"} /></Field>
              </div>
            </article>
          );
        })}
      </section>
    </>
  );

  const stepTwo = (
    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">02 / DEPLOYMENT</p><h2>Targets</h2><p>Define workspaces where this bundle can be deployed. No credentials are needed or stored.</p></div><span className="step-icon">02</span></div>
      <ErrorText message={errors.targets} />
      {config.targets.map((target, index) => (
        <article className="item-card" key={`target-${index}`}>
          <div className="item-title"><strong>Target {index + 1}</strong>{config.targets.length > 1 && <button type="button" className="text-button danger-text" onClick={() => update("targets", config.targets.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}</div>
          <div className="grid two">
            <Field label="Target name" error={errors[`target-${index}-name`]} hint="For example: dev, staging, or prod."><input value={target.name} onChange={(event) => setTarget(index, { name: event.target.value })} placeholder="dev" /></Field>
            <Field label="Workspace URL" error={errors[`target-${index}-url`]}><input type="url" value={target.workspace_url} onChange={(event) => setTarget(index, { workspace_url: event.target.value })} placeholder="https://your-workspace.cloud.databricks.com" /></Field>
          </div>
          <Field label="Bundle root path" error={errors[`target-${index}-root`]} hint="Absolute workspace path; bundle name and target interpolation are supported.">
            <input value={target.root_path} onChange={(event) => setTarget(index, { root_path: event.target.value })} placeholder="/Workspace/Shared/.bundle/${bundle.name}/${bundle.target}" />
          </Field>
          <div className="selection-box">
            <h3>Target variable overrides</h3>
            <p>Select the variables used in this target. Leave an override blank to use the bundle default.</p>
            {variables.length === 0 ? <span className="muted">Create variables on screen 1 to configure target overrides.</span> :
              variables.map((variable) => {
                const selected = target.variables.find((item) => item.variable_name === variable.name);
                return (
                  <div className="target-variable" key={variable.name || `target-variable-${index}`}>
                    <label className="check-row"><input type="checkbox" checked={!!selected} onChange={(event) => toggleTargetVariable(index, variable.name, event.target.checked)} /><span>{variable.name || "Untitled variable"}{variable.sensitive && <em className="sensitive-tag">sensitive</em>}</span></label>
                    {selected && <input className="override-input" aria-label={`Override for ${variable.name || "variable"}`} type={variable.sensitive ? "password" : "text"} autoComplete="new-password" value={selected.override_value} onChange={(event) => setTarget(index, { variables: target.variables.map((item) => item.variable_name === variable.name ? { ...item, override_value: event.target.value } : item) })} placeholder={variable.sensitive ? "Sensitive override" : "Optional override"} />}
                  </div>
                );
              })}
            <ErrorText message={errors[`target-${index}-variables`]} />
          </div>
        </article>
      ))}
      <button type="button" className="button button-secondary" onClick={() => update("targets", [...config.targets, emptyTarget()])}>＋ Add target</button>
    </section>
  );

  const stepThree = (
    <>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">03 / WORKLOAD</p><h2>Job settings</h2></div><span className="step-icon">03</span></div>
        <div className="grid two">
          <Field label="Job name" error={errors.job_name}><input value={config.job_name} onChange={(event) => update("job_name", event.target.value)} placeholder="Daily customer refresh" /></Field>
          <Field label="Maximum concurrent runs" error={errors.max_concurrent_runs} hint="Conservative default: 1."><input type="number" min="1" max="1000" value={config.max_concurrent_runs} onChange={(event) => update("max_concurrent_runs", Number(event.target.value))} /></Field>
        </div>
        <Field label="Description (optional)"><textarea rows={2} value={config.description} onChange={(event) => update("description", event.target.value)} placeholder="What this job does" /></Field>
        <div className="grid two">
          <Field label="Timeout in seconds (optional)" error={errors.timeout_seconds} hint="0 leaves the timeout unset."><input type="number" min="0" value={config.timeout_seconds} onChange={(event) => update("timeout_seconds", Number(event.target.value))} /></Field>
          <Field label="Schedule timezone" error={errors.schedule_timezone}><input value={config.schedule_timezone} onChange={(event) => update("schedule_timezone", event.target.value)} placeholder="UTC" /></Field>
        </div>
        <Field label="Quartz cron schedule (optional)" error={errors.schedule_cron} hint="Use six or seven Quartz fields; for example, 0 0 8 * * ?">
          <input value={config.schedule_cron} onChange={(event) => update("schedule_cron", event.target.value)} placeholder="0 0 8 * * ?" />
        </Field>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">TASK DEFINITIONS</p><h2>Tasks</h2><p>Every task runs on one of the clusters defined on screen 1.</p></div></div>
        <Field label="Number of tasks" error={errors.tasks}><input type="number" min="1" max="100" value={config.task_count} onChange={(event) => {
          const count = Math.max(1, Math.min(100, Number(event.target.value) || 1));
              const tasks = [...config.tasks];
              while (tasks.length < count) {
                const task = emptyTask(tasks.length);
                task.cluster_key = config.clusters[0]?.key ?? "";
                tasks.push(task);
              }
          update("task_count", count);
          update("tasks", tasks.slice(0, count));
        }} /></Field>
        <ErrorText message={errors["git-source"]} />
        {config.tasks.map((task, index) => (
          <article className="item-card task-card" key={`task-${index}`}>
            <div className="item-title"><strong>Task {index + 1}</strong><span className="task-number">{String(index + 1).padStart(2, "0")}</span></div>
            <div className="grid two">
              <Field label="Task key" error={errors[`task-${index}-key`]}><input value={task.task_key} onChange={(event) => setTask(index, { task_key: event.target.value })} placeholder={`task_${index + 1}`} /></Field>
              <Field label="Source"><select value={task.source} onChange={(event) => setTask(index, { source: event.target.value as Task["source"] })}><option value="WORKSPACE">Workspace</option><option value="GIT">Git</option></select></Field>
            </div>
            {task.source === "GIT" && <>
              <div className="callout">Databricks Jobs support one Git source per job. All Git tasks must use the same repository, provider, and ref.</div>
              <div className="grid two">
                <Field label="Repository URL" error={errors[`task-${index}-git-url`]}><input type="url" value={task.git_url} onChange={(event) => setTask(index, { git_url: event.target.value })} placeholder="https://github.com/org/repo.git" /></Field>
                <Field label="Git provider"><select value={task.git_provider} onChange={(event) => setTask(index, { git_provider: event.target.value })}>{providers.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></Field>
              </div>
              <div className="grid two">
                <Field label="Git ref type"><select value={task.git_ref_type} onChange={(event) => setTask(index, { git_ref_type: event.target.value as Task["git_ref_type"] })}><option value="branch">Branch</option><option value="tag">Tag</option><option value="commit">Commit</option></select></Field>
                <Field label={task.git_ref_type === "branch" ? "Branch" : task.git_ref_type === "tag" ? "Tag" : "Commit"} error={errors[`task-${index}-git-ref`]}><input value={task.git_ref} onChange={(event) => setTask(index, { git_ref: event.target.value })} placeholder={task.git_ref_type === "branch" ? "main" : "Ref value"} /></Field>
              </div>
            </>}
            <div className="grid two">
              <Field label={task.source === "GIT" ? "Repository-relative file path" : "Workspace file path"} error={errors[`task-${index}-path`]} hint={task.source === "GIT" ? "Do not include a leading slash." : "Use an absolute path in the workspace."}>
                <input value={task.path} onChange={(event) => setTask(index, { path: event.target.value })} placeholder={task.source === "GIT" ? "src/jobs/refresh.py" : "/Workspace/Shared/jobs/refresh.py"} />
              </Field>
              <Field label="File type"><select value={task.file_type} onChange={(event) => setTask(index, { file_type: event.target.value as Task["file_type"] })}><option>Python</option><option>Notebook</option></select></Field>
            </div>
            <Field label="Cluster" error={errors[`task-${index}-cluster`]}><select value={task.cluster_key} onChange={(event) => setTask(index, { cluster_key: event.target.value })}><option value="">Select a cluster</option>{config.clusters.map((cluster, clusterIndex) => <option value={cluster.key} key={`task-cluster-${clusterIndex}`}>{cluster.key || `Cluster ${clusterIndex + 1}`}</option>)}</select></Field>
            <div className="section-divider">
              <div className="subheading"><div><h3>Task parameters</h3><p>Each parameter maps to a CLI option (Python) or notebook base parameter.</p></div>
                <button type="button" className="button button-small" onClick={() => setTask(index, { parameters: [...task.parameters, { key: "", value: "", variable_name: "" }] })}>＋ Add parameter</button>
              </div>
              {task.parameters.map((parameter, parameterIndex) => (
                <div className="parameter-row" key={`parameter-${index}-${parameterIndex}`}>
                  <Field label="Parameter key" error={errors[`task-${index}-param-${parameterIndex}-key`]} hint="Enter the name with or without a leading --."><input value={parameter.key} onChange={(event) => setParameter(index, parameterIndex, { key: event.target.value })} placeholder="source_table" /></Field>
                  <Field label="Value"><input value={parameter.value} disabled={!!parameter.variable_name} onChange={(event) => setParameter(index, parameterIndex, { value: event.target.value })} placeholder={parameter.variable_name ? `Uses ${parameter.variable_name}` : "Value"} /></Field>
                  <Field label="Use variable" error={errors[`task-${index}-param-${parameterIndex}-variable`]}><select value={parameter.variable_name} onChange={(event) => setParameter(index, parameterIndex, { variable_name: event.target.value })}><option value="">Literal value</option>{variables.filter((item) => item.name).map((variable) => <option key={variable.name} value={variable.name}>{variable.name}</option>)}</select></Field>
                  <button type="button" className="icon-button danger-text" aria-label={`Remove parameter ${parameterIndex + 1}`} onClick={() => setTask(index, { parameters: task.parameters.filter((_, itemIndex) => itemIndex !== parameterIndex) })}>×</button>
                </div>
              ))}
              <ErrorText message={errors[`task-${index}-parameters`]} />
            </div>
          </article>
        ))}
      </section>
    </>
  );

  const stepFour = (
    <>
      <section className="panel review-panel">
        <div className="panel-heading"><div><p className="eyebrow">04 / READY TO BUILD</p><h2>Review your bundle</h2><p>Check the configuration. Use Edit to return to any screen.</p></div><span className="step-icon">04</span></div>
        <ReviewSection title="Bundle, variables & clusters" edit={() => goTo(0)}>
          <div className="review-pair"><span>Bundle name</span><strong>{config.bundle_name}</strong></div>
          <div className="review-pair"><span>Variables</span><strong>{config.variables.length || "None"}</strong></div>
          {config.variables.map((variable, index) => <div className="review-pair inset" key={`review-var-${index}`}><span>{variable.name || "Untitled"}{variable.sensitive && <em className="sensitive-tag">sensitive</em>}</span><strong>{variable.sensitive ? "Value omitted" : variable.default_value || "No default"}</strong></div>)}
          <div className="review-pair"><span>Job clusters</span><strong>{config.clusters.length}</strong></div>
          {config.clusters.map((cluster, index) => <div className="review-pair inset" key={`review-cluster-${index}`}><span>{cluster.key || `Cluster ${index + 1}`}</span><strong>{cluster.cloud} · {cluster.spark_version} · {cluster.node_type_id} · {cluster.scaling_mode === "fixed" ? `${cluster.num_workers} workers` : `${cluster.min_workers}–${cluster.max_workers} workers`}{cluster.policy_id && ` · policy ${cluster.policy_id}`}</strong></div>)}
        </ReviewSection>
        <ReviewSection title="Deployment targets" edit={() => goTo(1)}>
          {config.targets.map((target, index) => <div className="review-block" key={`review-target-${index}`}><strong>{target.name || `Target ${index + 1}`}</strong><span>{target.workspace_url}</span><code>{target.root_path}</code>{target.variables.map((item) => <small key={item.variable_name}>{item.variable_name}: {config.variables.find((v) => v.name === item.variable_name)?.sensitive ? "sensitive value omitted" : item.override_value || "default"}</small>)}</div>)}
        </ReviewSection>
        <ReviewSection title="Job & tasks" edit={() => goTo(2)}>
          <div className="review-pair"><span>Job</span><strong>{config.job_name}</strong></div>
          <div className="review-pair"><span>Concurrency</span><strong>{config.max_concurrent_runs}</strong></div>
          {config.timeout_seconds > 0 && <div className="review-pair"><span>Timeout</span><strong>{config.timeout_seconds} seconds</strong></div>}
          {config.description && <p className="review-description">{config.description}</p>}
          {config.schedule_cron && <div className="review-pair"><span>Schedule</span><strong>{config.schedule_cron} · {config.schedule_timezone}</strong></div>}
          {config.tasks.map((task, index) => <div className="review-block task-review" key={`review-task-${index}`}><strong>{task.task_key || `Task ${index + 1}`} · {task.source} {task.file_type}</strong><code>{task.path || "No path"}</code><span>Cluster: {task.cluster_key || "Not selected"}</span>{task.source === "GIT" && <span>{task.git_url} · {task.git_provider} · {task.git_ref_type}: {task.git_ref}</span>}{task.parameters.map((parameter, parameterIndex) => <small key={`review-param-${index}-${parameterIndex}`}>{parameter.key || "Parameter"}: {parameter.variable_name ? `variable ${parameter.variable_name}` : "literal value"}</small>)}</div>)}
        </ReviewSection>
      </section>
      <section className="generate-panel">
        <div><h3>Generate bundle files</h3><p>Creates <code>databricks.yml</code> and <code>resources/jobs.yml</code>. Download links expire in five minutes.</p></div>
        <button type="button" className="button button-primary generate-button" onClick={generate} disabled={generating}>{generating ? <><span className="spinner" /> Generating…</> : "Generate files"}</button>
      </section>
      {generationError && <div className="alert alert-error" role="alert"><strong>Generation failed</strong><p>{generationError}</p><button className="text-button" type="button" onClick={generate}>Retry generation</button></div>}
      {generated && <div className="alert alert-success" role="status"><strong>Bundle generated successfully</strong><p>Download each file before the links expire at {new Date(generated.expires_at).toLocaleTimeString()}. For CLI validation, keep <code>databricks.yml</code> at the bundle root and place the job file at <code>resources/jobs.yml</code> (create the <code>resources</code> folder if needed).</p><div className="download-list">{generated.files.map((file) => <button type="button" className="download-link" key={file.name} disabled={!!downloading} onClick={() => downloadFile(file.url)}><span className="file-icon">↓</span><span>{file.name}</span><span>{downloading === file.name ? "Downloading…" : "Download"}</span></button>)}</div>{downloadMessage && <p className={`download-message${downloadError ? " download-error" : ""}`} role={downloadError ? "alert" : "status"}>{downloadMessage}</p>}</div>}
    </>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Bundle Builder home"><span className="brand-mark">b</span><span>bundle<span className="brand-light">builder</span></span></a>
        <span className="topbar-note">Databricks Asset Bundles</span>
      </header>
      <main className="main-content">
        <div className="hero">
          <div className="hero-copy"><p className="eyebrow">CONFIGURE ONCE. DEPLOY WITH CONFIDENCE.</p><h1>Build your Databricks<br /><span>job bundle.</span></h1><p>Create a deployment-ready bundle with a guided setup. No credentials required.</p></div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-core"><span>DB</span></div><i className="art-dot dot-one" /><i className="art-dot dot-two" /><i className="art-dot dot-three" /></div>
        </div>
        <nav className="progress-nav" aria-label="Setup progress">
          {steps.map((label, index) => <button type="button" key={label} className={`progress-step${index === screen ? " active" : ""}${index < screen ? " complete" : ""}`} aria-current={index === screen ? "step" : undefined} onClick={() => goTo(index)}><span className="progress-number">{index < screen ? "✓" : `0${index + 1}`}</span><span>{label}</span></button>)}
        </nav>
        <div className="step-caption"><span>STEP 0{screen + 1} OF 04</span><span>{steps[screen]}</span></div>
        <div className="wizard-content">{[stepOne, stepTwo, stepThree, stepFour][screen]}</div>
        <div className="wizard-footer">
          <button type="button" className="button button-secondary" onClick={() => { setScreen(Math.max(0, screen - 1)); setErrors({}); }} disabled={screen === 0}>← Back</button>
          <span className="footer-note">Your setup is kept in this browser tab.</span>
          {screen < 3 ? <button type="button" className="button button-primary" onClick={next}>Continue <span aria-hidden="true">→</span></button> : <button type="button" className="button button-primary" onClick={generate} disabled={generating}>{generating ? "Generating…" : "Generate bundle"}</button>}
        </div>
        <footer className="page-footer"><span>Bundle Builder</span><span>Generated files are temporary and expire after five minutes.</span></footer>
      </main>
    </div>
  );
}

function ReviewSection({ title, edit, children }: { title: string; edit: () => void; children: ReactNode }) {
  return <section className="review-section"><div className="review-heading"><h3>{title}</h3><button type="button" className="text-button" onClick={edit}>Edit</button></div>{children}</section>;
}

export default App;
