# config

Environment-validation primitives and value normalizers shared by every service.

## Contents

`booleanValue`, `nodeEnvironment`, `port` and `postgresUrl` are the Joi
validators that every service's environment schema needs. `normalizeEmail` trims
and lowercases an address.

## Why this library exists separately

These primitives could not live in `@pixaeron/nestjs`. That barrel re-exports an
HTTP bootstrap which imports express, so consuming it from Notifications — whose
entrypoint is gRPC, not HTTP — would drag an HTTP server into a service that
does not run one. Keep this library free of framework dependencies for the same
reason.

`normalizeEmail` is a cross-service contract rather than a three-line helper.
Auth normalizes an address before putting it on the wire; Notifications
normalizes before computing its recipient HMAC. If the two implementations ever
drift, the hashes stop matching and suppression silently stops applying, with no
error anywhere. That is why there is exactly one implementation.

## Running unit tests

Run `nx test config` to execute the unit tests via [Jest](https://jestjs.io).
