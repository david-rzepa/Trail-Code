# Re-review: portable committed-target execution

## Truth / feasibility

The design promises a portable ordinary-Git execution path, yet gives only two required properties (immutable isolated inputs or reliable observation/serialization) rather than a viable mechanism for any supported platform. A temporary directory and file permissions alone are explicitly insufficient, and Node's ordinary filesystem operations do not by themselves prevent a same-user test process or concurrent process from editing and reverting source. Without choosing and validating a practical mechanism, implementation can reach the specified fail-closed behavior on every platform and still leave the product unable to validate even a full committed-target run. The design should identify the supported initial platforms and a non-privileged production mechanism that ensures or reliably detects mutation and observation loss across the entire interval, including edit-and-revert. Include an early real-platform feasibility test with a passing full run and an invalidated mid-run mutation; if no method is feasible, surface the limitation before design approval or ask the owner to choose a revised guarantee.

The change otherwise retains exact commit IDs, separate requested and resolved inputs, conservative analyzer validation, symlink containment, original test workflow and evidence rules.
