# Notifications contract

This library owns the versioned protobuf contract shared by Auth and
Notifications. The package declaration and source directory both use
`pixaeron/notifications/v1`.

Run commands from the workspace root:

- `npm run contracts:generate` updates generated TypeScript after an intentional
  protobuf change.
- `npm run contracts:check` runs Buf lint and verifies that generated files are
  current.
- `npm run contracts:breaking` compares the current contract with `NX_BASE`,
  or `main` when `NX_BASE` is unset. It skips only when that base has no
  protobuf contract yet.
