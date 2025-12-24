---
paths: .github/workflows/**/*.yml
---
# CI/CD Rules

| Standard | Rule |
|----------|------|
| * Matrix-Test | Test across Python versions (3.9-3.12) |
| * Dep-Cache | Cache pip/poetry dependencies |
| * Secrets | Use GitHub secrets, never hardcode |
| * Concurrency | Cancel in-progress runs on new push |
| * Artifacts | Upload coverage/test reports |
