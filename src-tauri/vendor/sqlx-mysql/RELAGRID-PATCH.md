Upstream: sqlx-mysql 0.8.6, https://github.com/launchbadge/sqlx/tree/v0.8.6/sqlx-mysql

Upstream Git SHA: bab1b022bd56a64f9a08b46b36b97c5cff19d77e

Published crate SHA256: aa003f0038df784eb8fecbbac13affe3da23b45194bd57dba231c8f48199c526

Retained MIT/Apache-2.0 licenses. RelaGrid packet patch is in
`src/connection/stream.rs`: reject advertised MySQL packet lengths over
8,000,000 bytes after reading the four-byte header and before payload read.
Because this limit is below MySQL's 16,777,215 byte continuation segment,
multi-segment packet assembly cannot begin. This applies to all MySQL
connections, including full-table CSV export. Reapply and verify the patch
when upgrading SQLx; removing the Cargo patch removes this protection.

`src/connection/executor.rs` additionally rejects more than 512 metadata
columns before capacity allocation and column names over 4096 bytes before
retaining them. Fake-socket regression confirms oversized payload is unread.
Oversized packet/count errors poison the stream so pooled connections cannot
be reused; `src/connection/tls.rs` initializes the poison flag on TLS upgrade.

The ceiling bounds accepted protocol payloads, not process RSS: buffered IO,
TLS, allocator capacity, metadata, saved results and concurrent connections
also consume memory. Driver IO can prefetch bytes while reading the header.

A trailing-whitespace-only cleanup is included in src/testing/mod.rs.
