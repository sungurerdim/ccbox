---
paths: ".github/workflows/*.yml, .github/workflows/*.yaml"
---
# CI/CD Rules (GitHub Actions)

- **Matrix-Test**: Matrix for multiple Python versions (3.9, 3.10, 3.11, 3.12)
- **Cache-Deps**: Cache pip dependencies
- **Secrets-Safe**: Use GitHub Secrets for sensitive data
- **Concurrency-Limit**: Cancel redundant runs
- **CI-Gates**: lint + test + coverage gates on every PR
- **Config-as-Code**: Versioned configuration
