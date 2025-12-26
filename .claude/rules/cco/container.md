---
paths: "**/Dockerfile*, **/docker-compose*.yml, **/*.dockerfile"
---
# Container Rules

- **Multi-Stage**: Multi-stage builds for smaller images
- **Layer-Cache**: Order commands for optimal layer caching
- **Non-Root**: Run as non-root user
- **Health-Check**: HEALTHCHECK instruction for orchestrators
- **Env-Inject**: Environment variables for configuration
- **Buildkit-Secrets**: Use --mount=type=secret for sensitive build args
- **Cache-Mounts**: Use --mount=type=cache for package managers
- **Distroless**: Use distroless or alpine for production images
