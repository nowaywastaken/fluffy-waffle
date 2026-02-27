# Fluffy Waffle - Development Guide

## Target Platforms

Linux, macOS. **Windows is not a target platform.**

- No Named Pipe implementation
- No cmd.exe shims
- No WSL2 workarounds
- Unix socket only for IPC

## Key Constraints

- Bootstrap LOC budget: strictly < 500 LOC
- All commands must use argument arrays via spawn() or execFileNoThrow() — never string templates
- Test runner: Node.js built-in (node:test), no extra test dependencies
- Container runtime is a hard dependency — no fallback mode

## Project Structure

```
src/
  bootstrap/        - Trust anchor, starts L1 Kernel container
  kernel/
    container/      - L2 sandbox lifecycle management
    ipc/            - Unix socket transport
    security/       - Policy engine
    ai/             - AI provider adapters
  utils/            - Shared utilities (execFileNoThrow, etc.)
docs/plans/         - Architecture and implementation plans
```

## Commands

```bash
npm run build              # TypeScript compile
npm test                   # Run all tests
npm run test:container     # Run container module tests only
```

## References

- Architecture: docs/plans/2026-02-26-architecture-design.md
- Bootstrap design: docs/plans/2026-02-27-bootstrap-implementation-design.md
- Container Manager design: docs/plans/2026-02-27-container-manager-design.md
