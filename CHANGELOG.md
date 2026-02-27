# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- IPC Transport Layer with zero-trust peer identity verification
  - SO_PEERCRED (Linux) / LOCAL_PEERCRED (macOS) via native C++ addon (native/peer_cred.cc)
  - Zero-trust: reject connection immediately if peer identity cannot be verified
  - Fail-closed: all connections rejected if native addon is not built/available
  - Socket file permissions: chmod 600 (owner read/write only, was 700)
  - Decoupled MessageHandler callback replaces tight Dispatcher coupling
  - Types extracted to types.ts, ProtocolHandler extracted to protocol.ts
  - Dispatcher: PolicyEngine dependency removed (deferred to Phase 2), imports fixed
  - Bootstrap health check migrated to IPC frame format (unified protocol)
- Container Manager module
  - ContainerRuntime interface (DockerAdapter via execFileNoThrow, no shell injection)
  - Sandbox lifecycle state machine with valid-transition enforcement
  - Four sandbox templates: ai-provider, code-executor, policy-sandbox, integration-test
  - Three Seccomp profiles with default-deny (strict, standard, standard-net)
  - Idempotent cleanup (each step independent, failures logged not thrown)
  - Orphan container scanner on startup (fw-sandbox- prefix)
  - max_duration timer enforced from host
  - execFileNoThrow utility (src/utils/)
- Bootstrap layer implementation with health check and crash recovery
  - Unix socket health check with ping/pong protocol
  - Exponential backoff restart strategy (1s -> 2s -> 4s, max 4s)
  - DinD security configuration with hardcoded constants (SECURITY_FLAGS, MOUNT_CONFIG, NETWORK_CONFIG, RESOURCE_LIMITS)
  - Structured error reporting (what/why/fix/context)
  - CLI argument parsing (--help, --version, --config, --runtime)
  - Uses spawnSync/spawn instead of execSync for command injection prevention
  - Monitor loop with restart limit (3 crashes in 5 minutes)
  - LOC budget: 389 LOC (within 500 LOC limit)
- Initial project structure and repository setup
- Architecture design document (docs/plans/2026-02-26-architecture-design.md)
- Project memory system (.claude/projects/-Users-nowaywastaken-codespaces-fluffy-waffle/memory/)
- Development tracking files (TODO.md, CHANGELOG.md)

### Documentation
- Comprehensive architecture design covering:
  - Three-layer security model (Bootstrap, L1 Workspace, L2 Sandbox)
  - Zero-trust security policy engine with YAML + TypeScript rules
  - Container-based isolation using Docker/Podman
  - TDD-enforced state machine workflow
  - AI tools integration with native Function Calling
  - Plugin system with capability-based security
  - Audit logging with chain integrity
  - IPC transport abstraction (Unix socket / Named Pipe)

### Technical Decisions
- Language: TypeScript
- Policy sandbox runtime: Deno
- Container runtime: Docker/Podman (hard dependency)
- Storage: SQLite (WAL mode)
- License: MIT
- Supported platforms: Linux, macOS (Windows dropped from v1 scope)

### Removed
- Windows (WSL2) support dropped from v1 scope
  - Named Pipe IPC transport removed from roadmap
  - GetNamedPipeClientProcessId peer identity check removed
  - execFileNoThrow Windows cmd.exe shim not required

## [0.0.0] - 2026-02-26

### Added
- Initial commit with project foundation
- .gitignore configuration
- Basic documentation structure

---

## Version History

- **Unreleased**: Active development phase
- **0.0.0**: Project initialization

---

## Notes

### Versioning Strategy
- Major version (X.0.0): Breaking changes to architecture or public API
- Minor version (0.X.0): New features, non-breaking changes
- Patch version (0.0.X): Bug fixes, documentation updates

### Change Categories
- **Added**: New features
- **Changed**: Changes in existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security-related changes
- **Documentation**: Documentation updates
- **Technical Decisions**: Architecture and design decisions
