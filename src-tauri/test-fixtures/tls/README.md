# TLS test fixtures

These certificates and the deliberately public private key are used only by the loopback MySQL TLS test server. Never use them for a real service. The signing CA private key is not included. No production credentials are used.

`server.der` has localhost and 127.0.0.1 subject alternative names. `wrong-host.der` has only wrong.example.invalid. `expired.der` is already expired. All three share the test server key. Valid certificates expire in September 2036; regenerate fixtures before then. Tests fail closed if certificates are no longer valid.
