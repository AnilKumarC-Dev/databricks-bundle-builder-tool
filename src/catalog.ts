export const runtimeOptions = [
  "15.4.x-scala2.12",
  "15.4.x-photon-scala2.12",
  "16.4.x-scala2.12",
  "16.4.x-photon-scala2.12",
  "Custom",
];

export const nodeTypeOptions: Record<string, string[]> = {
  AWS: ["i3.xlarge", "m5d.large", "m5d.xlarge", "m6i.large", "m6i.xlarge", "Custom"],
  Azure: ["Standard_DS3_v2", "Standard_DS4_v2", "Standard_D4s_v3", "Standard_D8s_v3", "Custom"],
  GCP: ["n1-standard-4", "n1-standard-8", "n2-standard-4", "n2-standard-8", "Custom"],
};

export const providers = [
  { label: "GitHub", value: "gitHub" },
  { label: "GitHub Enterprise", value: "gitHubEnterprise" },
  { label: "GitLab", value: "gitLab" },
  { label: "GitLab Enterprise Edition", value: "gitLabEnterpriseEdition" },
  { label: "Bitbucket Cloud", value: "bitbucketCloud" },
  { label: "Bitbucket Server", value: "bitbucketServer" },
  { label: "Azure DevOps Services", value: "azureDevOpsServices" },
];
