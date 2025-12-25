---
paths: ".github/workflows/*.yml,.gitlab-ci.yml,Jenkinsfile"
---
# CI/CD Rules

## GitHub Actions
- **Matrix-Test**: Matrix for multiple versions
- **Cache-Deps**: Cache dependencies
- **Secrets-Safe**: Use GitHub Secrets
- **Concurrency-Limit**: Cancel redundant runs

## General CI
- **CI-Gates**: lint + test + coverage gates
- **Fast-Fail**: Fail fast on first error
- **Parallel-Jobs**: Parallelize independent jobs
