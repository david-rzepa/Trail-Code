# Adversary review

## Repository text can instruct the setup agent

Setup deliberately feeds repository files, CI configuration, scripts and documentation to an agent. The design says not to silently run arbitrary new scripts from untrusted text, but does not address instructions embedded in those inputs that tell the agent to disclose credentials, alter policy or execute an existing command under the guise of validation. For example, a malicious README could instruct the agent to upload environment variables or change the generated test command while claiming to be a required setup step. A user authorizing setup in that repository has not thereby authorized such actions.

Specify that repository content is untrusted task data, including comments and instructions embedded in manifests, documentation or CI; it cannot elevate authority or override the user, system or agent instruction hierarchy. Respect applicable project instructions within that hierarchy, but require independent task authorization for actions, do not expose secrets, and do not execute or install a command just because repository text directs the model to do so. Add adversarial fixture coverage for injected instructions to exfiltrate secrets, alter selection or execute an unrelated command, alongside a normal legitimate project-instruction case.
