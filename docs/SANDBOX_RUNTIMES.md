# Runtime-aware execution sandbox

`run_command` executes inside Docker by default. The sandbox detects the workspace runtime and can lazily switch to a matching runtime image when a command requires another toolchain.

| Runtime | Detection examples | Default image |
| --- | --- | --- |
| Node.js | `package.json`, `node`, `npm`, `npx` | `node:<detected-major>-alpine` |
| .NET | `.sln`, `.csproj`, `global.json`, `dotnet` | `mcr.microsoft.com/dotnet/sdk:<target-version>` |
| Python | `pyproject.toml`, requirements files, `python`, `pip`, `pytest` | `python:<detected-version>-slim` |
| Java | `pom.xml`, Gradle files, `mvn`, `gradle` | Maven/Gradle JDK 21 image |
| Go | `go.mod`, `go` | `golang:<go.mod-version>-alpine` |
| Rust | `Cargo.toml`, `cargo`, `rustc` | `rust:1-slim` |

Runtime switching is enabled by default. Set `SANDBOX_RUNTIME_AUTO_SWITCH=false` to keep the workspace's initial profile. Set `SANDBOX_DOCKER_IMAGE` to pin a custom image; an explicit image always takes precedence and disables automatic image switching.

Compound commands that require different runtimes, such as `npm test && dotnet test`, are rejected with `MULTIPLE_RUNTIMES_REQUIRED`. Split them into separate `run_command` calls so each command executes in the correct isolated image.

When a project intentionally depends on a host-native library (for example a Windows-only `.dll` package while Docker uses Linux), `run_command` returns `recommendedExecutionTarget: "host"`. The agent can retry an allowlisted command with `execution_target: "host"`; commands outside the host allowlist remain blocked. The default `execution_target: "auto"` continues to prefer the isolated sandbox.

## Structured failures

Every non-zero command result is marked as a failure. Environment failures use stable error codes:

- `COMMAND_NOT_FOUND`: executable missing (shell exit 127).
- `COMMAND_NOT_EXECUTABLE`: permissions, shebang, file format, or architecture problem.
- `COMMAND_TIMEOUT`: foreground execution exceeded the limit.
- `COMMAND_RESOURCE_LIMIT`: process was likely killed by the memory/resource limit.
- `NATIVE_DEPENDENCY_MISSING`: native `.so`/`.dll`/`.dylib` is missing or incompatible with the container platform.
- `PACKAGE_DEPENDENCY_MISSING`: language package/module has not been restored or installed.
- `RUNTIME_SANDBOX_INIT_FAILED`: Docker could not start the required runtime image.

The result includes `diagnostic`, `suggestion`, runtime/image metadata, and `missingExecutable` when known. The agent loop stops after the same missing-executable failure class occurs three times, preventing repeated retries without an environment change.

The final-answer guard also rejects status messages that promise future execution (for example, “I will continue in another environment”). The agent must either execute the next tool call immediately or return an evidence-backed terminal blocker without claiming that work will continue later.

Foreground commands default to a 120-second timeout. Configure `RUN_COMMAND_TIMEOUT_MS` globally or pass `timeout_ms` (1,000-300,000 ms) to `run_command` for unusually short or long operations. Timeouts are returned as `COMMAND_TIMEOUT` rather than a generic test failure.
