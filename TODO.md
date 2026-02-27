# TODO

## Current Status

**Phase**: Initial Development
**Mode**: Architecture Implementation
**Last Updated**: 2026-02-27

---

## Phase 1: Foundation (Priority 1)

### Bootstrap Layer
- [x] Implement bootstrap binary (< 500 LOC budget)
  - [x] Configuration reading (~80 LOC)
  - [x] Container runtime detection (~40 LOC)
  - [x] Container startup logic (~120 LOC)
  - [x] Health check (ping/pong) (~60 LOC)
  - [x] Crash recovery mechanism (~80 LOC)
  - [x] Entry point + CLI parsing (~60 LOC)
  - [x] Error reporting (~60 LOC)

### Container Manager Module
- [ ] Define ContainerRuntime interface
- [ ] Implement Docker adapter
- [ ] Implement Podman adapter
- [ ] Sandbox lifecycle state machine
- [ ] Sandbox configuration templates
  - [ ] ai-provider template
  - [ ] code-executor template
  - [ ] policy-sandbox template
  - [ ] integration-test template
- [ ] Output volume management
- [ ] Image pre-caching mechanism
- [ ] Volume pool for latency optimization

### IPC Transport Layer
- [ ] Define IPC interfaces (IpcTransport, IpcConnection, PeerIdentity)
- [ ] Implement Unix socket transport (Linux/macOS)
- [ ] Implement Named Pipe transport (Windows)
- [ ] Peer identity verification
  - [ ] SO_PEERCRED (Linux)
  - [ ] LOCAL_PEERCRED (macOS)
  - [ ] GetNamedPipeClientProcessId (Windows)
- [ ] Length-prefixed JSON wire protocol
- [ ] IPC message serialization/deserialization

---

## Phase 2: Security Core (Priority 1)

### Security Policy Module
- [ ] Policy rule evaluation engine
- [ ] Built-in rules (max 10)
  - [ ] Meta-policy protection
  - [ ] Bootstrap file protection
  - [ ] Kernel process file protection
  - [ ] Audit log protection
  - [ ] State machine DB protection
- [ ] YAML rule parser and indexer
- [ ] TypeScript extension sandbox (Deno)
- [ ] Capability token system
  - [ ] Token issuer
  - [ ] Token validation (O(1))
  - [ ] Replay prevention (monotonic nonce)
- [ ] Capability tag system
- [ ] Meta-policy update mechanism
- [ ] Unit specification parser (IEC/SI, time units)

### Policy Engine Tests (26 test cases)
- [ ] Basic semantics (cases 1-6)
- [ ] Token path (cases 7-9, 21-23)
- [ ] Except mechanism (cases 13-15, 26)
- [ ] Aggregation behavior (cases 10-12, 16-17)
- [ ] Defensive boundaries (cases 18-20, 24-25)

### Audit Log Module
- [ ] SQLite schema design (WAL mode)
- [ ] AuditEntry record format
- [ ] Chain integrity (SHA-256 hash chain)
- [ ] Sync/async write strategy
- [ ] Buffer management (max 100, flush 500ms)
- [ ] Retention policy implementation
- [ ] Storage warning system
- [ ] Chain integrity verification at startup

---

## Phase 3: State Management (Priority 1)

### State Machine Module
- [ ] State and mode definitions
- [ ] Transition rules
  - [ ] Strict mode workflow
  - [ ] Explore mode workflow
  - [ ] Debug mode workflow
- [ ] Transition guards
- [ ] TDD exemption mechanism
- [ ] Tech debt budget (coverage-based)
- [ ] Session mode switching
- [ ] SQLite persistence with chain integrity

### Scheduler Module
- [ ] Task model and priority system
- [ ] Priority queue (min-heap)
- [ ] Dependency graph (DAG)
- [ ] Concurrency limits management
- [ ] Preemption strategy (pause/destroy)
- [ ] Event-driven scheduling loop
- [ ] Starvation prevention

---

## Phase 4: AI Integration (Priority 2)

### AI Tools Module
- [ ] Tool Router implementation
- [ ] Kernel-native fast path tools
  - [ ] fs.read
  - [ ] search.grep
  - [ ] search.glob
  - [ ] fs.list
  - [ ] fs.exists
- [ ] AI Provider adapter interface
- [ ] Provider implementations
  - [ ] OpenAI adapter
  - [ ] Anthropic adapter
  - [ ] Google adapter
- [ ] Tool call normalization
- [ ] Streaming support (StreamEvent types)
- [ ] Context management
  - [ ] Tool context (conservative strategy)
  - [ ] Conversation history (sliding window + summary)
  - [ ] Token budget management
- [ ] Parallel tool call handling
- [ ] Output sanitization
- [ ] Retry strategy

### Tool Plugin SDK
- [ ] ToolPlugin interface
- [ ] ToolContext implementation
- [ ] Plugin sandbox runtime
- [ ] Tool definition schema

---

## Phase 5: Plugin System (Priority 2)

### Plugin System Module
- [ ] Plugin lifecycle state machine
- [ ] Plugin manifest schema
- [ ] PluginRegistry implementation
- [ ] Plugin discovery and scanning
- [ ] Plugin isolation (L2 sandboxes)
- [ ] Capability pre-check
- [ ] Version compatibility negotiation
- [ ] Plugin identity and security

### Built-in Plugins
- [ ] fs-tool
- [ ] search-tool
- [ ] git-tool
- [ ] test-tool

---

## Phase 6: CLI Layer (Priority 2)

### CLI Implementation
- [ ] Command structure
- [ ] Interactive mode
- [ ] Direct task execution mode
- [ ] Session management commands
- [ ] Plugin management commands
- [ ] Configuration commands
- [ ] Audit commands
- [ ] Interactive output rendering
- [ ] Error display standard
- [ ] Configuration hierarchy

---

## Phase 7: Network & Advanced Features (Priority 3)

### Network Isolation
- [ ] Application-layer HTTP/HTTPS proxy
- [ ] Unix socket proxy listener
- [ ] socat TCP-to-Unix forwarding
- [ ] Host whitelist enforcement
- [ ] CONNECT tunnel support
- [ ] Proxy audit logging

### Seccomp Profiles
- [ ] strict profile (policy sandbox, AI provider)
- [ ] standard profile (code executor)
- [ ] standard-net profile (integration tests)

### Output Management
- [ ] Patch mode implementation
- [ ] Full-file mode fallback
- [ ] Merge process
- [ ] Auto-merge criteria
- [ ] Human review workflow

---

## Phase 8: Error Recovery & Reliability (Priority 3)

### Error Recovery
- [ ] L1 container crash recovery
- [ ] SQLite corruption handling
- [ ] WAL checkpoint strategy
- [ ] Periodic snapshot backups
- [ ] Output volume merge failure recovery
- [ ] Kernel OOM defense
- [ ] Orphan resource cleanup

---

## Phase 9: Testing & Documentation (Priority 2)

### Testing
- [ ] Unit tests for all modules
- [ ] Integration tests
- [ ] End-to-end scenario tests
- [ ] Policy engine test suite (26 cases)
- [ ] Performance benchmarks
  - [ ] Sandbox creation: 200-300ms target
  - [ ] Tool call overhead: 50ms target

### Documentation
- [ ] User guide
- [ ] Plugin development guide
- [ ] Policy configuration guide
- [ ] API reference
- [ ] Troubleshooting guide

---

## Future Enhancements (Out of Scope for v1)

- [ ] Central plugin registry
- [ ] Distributed/multi-machine deployment
- [ ] Cryptographic tamper-proofing (TPM/remote trust anchor)
- [ ] Custom seccomp profiles
- [ ] Inter-plugin direct communication
- [ ] Dynamic priority scheduling
- [ ] Layer 2 on-demand tool context loading
- [ ] Container-less degradation mode

---

## Notes

- Bootstrap LOC budget: < 500 LOC (strictly enforced)
- Sandbox creation target: 200-300ms
- Tool call overhead target: 50ms
- Policy engine: 26 normative test cases
- All write operations must go through L2 sandbox isolation
- Container runtime is a hard dependency (no fallback mode)
