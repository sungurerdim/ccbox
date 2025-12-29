---
paths: "**/.github/**/*.{yml,yaml},**/.gitlab-ci.yml,**/azure-pipelines.yml,**/.circleci/**/*"
---

# CI-CD Rules
*Trigger: CI-CD*

## Pipeline Structure

- **Fail-Fast**: Run linting/type checks before tests to fail quickly on syntax errors
- **Parallel-Jobs**: Run independent jobs in parallel (lint, type-check, test)
- **Artifacts-Cache**: Cache dependencies (pip, npm) to speed up builds
- **Conditional-Stages**: Run E2E/deployment only on specific branches (main, release)

## Testing in CI

- **All-Tests-Required**: All tests must pass before merge (blocking)
- **Coverage-Reports**: Report coverage in PR comments for visibility
- **Test-Isolation**: Tests must not depend on order or shared state
- **Docker-Available**: Docker daemon available for container tests

## Code Quality Checks

- **Linting-Enforced**: ruff check output must pass (exit code 0)
- **Type-Checking**: mypy --strict must pass on all source files
- **Format-Check**: Code must match formatter expectations (ruff format check)
- **Security-Scan**: Run security scanner (bandit for Python) on code changes

## Version & Release

- **Semantic-Versioning**: Follow MAJOR.MINOR.PATCH versioning
- **Changelog-Update**: Update CHANGELOG.md with breaking changes and new features
- **Tag-Release**: Create git tags for releases in X.Y.Z format
- **Build-Artifact**: Build and publish artifacts only on release tags

## Secrets & Credentials

- **Secrets-Encrypted**: Use encrypted secrets (GitHub Secrets, GitLab CI/CD Variables)
- **No-Hardcoded**: Never commit secrets, API keys, or credentials
- **Rotation**: Rotate secrets regularly, especially after personnel changes
- **Access-Logging**: Log secret access attempts for audit trail
