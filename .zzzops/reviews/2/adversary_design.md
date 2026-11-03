# Adversary review

## Receipt provenance

The design does not establish a trust boundary for the repository-scoped receipt store. A checkout can contain attacker-supplied, schema-valid JSON that claims successful full verification for a known commit and public configuration identities. Merely describing the directory as uncommitted or checking a record's fields does not establish that the helper created it after a successful run. If that record is loaded as a valid A baseline, a later sparse or empty run can create a passing B receipt while required tests never ran.

Require a local receipt store that cannot be populated through versioned/untrusted checkout inputs, including a rule for symlinks and replacement of the store. Define what local identity and permissions are trusted, reject tracked/imported records and unsafe or unverifiable store locations, and use full fallback when provenance is unavailable. Test a forged tracked JSON record, a symlinked store and unsafe or replaced store. This does not claim protection against a malicious user with the same local authority; it prevents repository-controlled data being mistaken for locally generated verification evidence.
