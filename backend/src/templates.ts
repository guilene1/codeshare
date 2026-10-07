export const templates: Record<string, Array<[string, string, string]>> = {
  empty: [],
  terraform: [
    [
      "main.tf",
      "hcl",
      'terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n\nprovider "aws" {\n  region = var.aws_region\n}\n',
    ],
    [
      "variables.tf",
      "hcl",
      'variable "aws_region" {\n  description = "AWS region for this lesson"\n  type        = string\n  default     = "us-east-1"\n}\n',
    ],
    ["outputs.tf", "hcl", "# Add outputs as you build the lesson.\n"],
  ],
  kubernetes: [
    [
      "deployment.yaml",
      "yaml",
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: classroom-app\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: classroom-app\n  template:\n    metadata:\n      labels:\n        app: classroom-app\n    spec:\n      containers:\n        - name: web\n          image: nginx:stable\n          ports:\n            - containerPort: 80\n",
    ],
    [
      "service.yaml",
      "yaml",
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: classroom-app\nspec:\n  selector:\n    app: classroom-app\n  ports:\n    - port: 80\n      targetPort: 80\n",
    ],
    [
      "gateway.yaml",
      "yaml",
      "# Requires Gateway API CRDs and a compatible controller.\napiVersion: gateway.networking.k8s.io/v1\nkind: Gateway\nmetadata:\n  name: classroom-gateway\nspec:\n  gatewayClassName: example\n  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n",
    ],
  ],
  python: [
    [
      "main.py",
      "python",
      'def greet(name):\n    return f"Hello, {name}!"\n\n\nprint(greet("class"))\n',
    ],
  ],
  devops: [
    [
      "notes.md",
      "markdown",
      "# DevOps Lab\n\n## Learning goals\n\n- Explain the workflow\n- Build a small example\n- Review the result together\n\n## Commands\n\n```bash\npwd\nls -la\n```\n",
    ],
    [
      "commands.sh",
      "shell",
      "#!/usr/bin/env bash\n# Add commands for your lesson here.\npwd\n",
    ],
    [
      "Dockerfile",
      "dockerfile",
      "FROM nginx:stable-alpine\n# Add your lesson configuration here.\n",
    ],
  ],
};
