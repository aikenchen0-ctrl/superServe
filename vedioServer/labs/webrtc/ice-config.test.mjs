import test from "node:test";
import assert from "node:assert/strict";
import "./ice-config.js";

const parse = globalThis.liveParseIceLinks;
const password = 'long-password-with-32-bytes-";<,>\\tail';
const quoted = value => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const link = (port = 3478) => `<turn:127.0.0.1:${port}?transport=udp>; rel="ice-server"; username="user"; credential=${quoted(password)}; credential-type="password"`;

test("引号中的逗号分号尖括号和转义不会改变服务器边界", () => {
  const result = parse(`${link()}, ${link(3479)}`, "130", 100);
  assert.equal(result.servers.length, 2);
  assert.equal(result.servers[0].credential, password);
  assert.equal(result.expires, 130);
});

test("注入重复参数无效目的地和超量响应全部拒绝", () => {
  for (const value of [
    `${link()},`, `${link()}, ${link()}`, `${link()}; username="other"`,
    link().replace("127.0.0.1", "8.8.8.8"), link().replace("3478", "80"),
    link().replace("127.0.0.1", "127.00.0.1"), link().replace("transport=udp", "transport=tcp"),
    link().replace('username="user"', 'username="bad\\q"'),
    link().replace('rel="ice-server"', 'rel="other"'), `${link()}\r\nX-Test: injected`,
    [3478, 3479, 3480, 3481, 3482].map(link).join(", "), "x".repeat(8193),
  ]) assert.throws(() => parse(value, "130", 100));
});

test("到期未知和超长有效期不能成为零值或无限授权", () => {
  for (const expiry of [null, "", "0", "100", "401", "NaN", "130x"]) {
    assert.throws(() => parse(link(), expiry, 100));
  }
});
