---
paths: Dockerfile, docker-compose*
---
# Container Rules

| Standard | Rule |
|----------|------|
| * Multi-Stage | Separate build and runtime stages |
| * Non-Root | Run as non-root user in production |
| * Layer-Cache | Order COPY commands by change frequency |
| * Health-Check | HEALTHCHECK instruction for orchestration |
| * CVE-Scan | Scan images in CI pipeline |
| * Minimal-Base | Use distroless or alpine when possible |
