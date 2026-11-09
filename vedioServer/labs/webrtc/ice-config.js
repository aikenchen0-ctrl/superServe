// SPDX-License-Identifier: MIT
// 改编MediaMTX的readQuotedCredential，按本项目有限Link输出解析，不按逗号或分号直接拆凭据。
// Copyright (c) 2019 aler9
globalThis.liveParseIceLinks = (raw, expiry, now = Math.floor(Date.now() / 1000)) => {
  const invalid = () => new Error("ICE发现响应格式或有效期超出限定范围");
  if (typeof raw !== "string" || !raw.length || raw.length > 8192 ||
      !/^[\x20-\x7e]+$/.test(raw) || !/^[0-9]{1,12}$/.test(expiry || "")) throw invalid();
  const expires = Number(expiry);
  if (!Number.isSafeInteger(now) || expires <= now || expires - now > 300) throw invalid();
  let offset = 0;
  const skip = () => { while (raw[offset] === " ") offset++; };
  const quoted = () => {
    if (raw[offset++] !== '"') throw invalid();
    let value = "";
    while (offset < raw.length) {
      let character = raw[offset++];
      if (character === '"') return value;
      if (character === "\\") {
        character = raw[offset++];
        if (character !== "\\" && character !== '"') throw invalid();
      }
      if (!character) throw invalid();
      value += character;
    }
    throw invalid();
  };
  const servers = [];
  const urls = new Set();
  while (offset < raw.length) {
    skip();
    if (raw[offset++] !== "<") throw invalid();
    const end = raw.indexOf(">", offset);
    if (end < 0) throw invalid();
    const url = raw.slice(offset, end);
    const match = /^turn:(\d+\.\d+\.\d+\.\d+):([0-9]+)\?transport=udp$/.exec(url);
    if (!match) throw invalid();
    const octets = match[1].split(".").map(Number);
    const port = Number(match[2]);
    const [a, b] = octets;
    if (octets.some(value => value > 255) || octets.join(".") !== match[1] ||
        !((a === 10) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127) ||
        port < 1024 || port > 65535 || String(port) !== match[2] || urls.has(url)) throw invalid();
    offset = end + 1;
    const params = new Map();
    skip();
    while (raw[offset] === ";") {
      offset++;
      skip();
      const name = /^[a-z-]+/.exec(raw.slice(offset))?.[0];
      if (!name || params.has(name)) throw invalid();
      offset += name.length;
      if (raw[offset++] !== "=") throw invalid();
      params.set(name, quoted());
      skip();
    }
    const username = params.get("username");
    const credential = params.get("credential");
    if (params.size !== 4 || params.get("rel") !== "ice-server" || params.get("credential-type") !== "password" ||
        !/^[\x21-\x7e]{1,64}$/.test(username || "") || !/^[\x21-\x7e]{32,128}$/.test(credential || "")) throw invalid();
    servers.push({ urls: [url], username, credential });
    urls.add(url);
    if (servers.length > 4) throw invalid();
    if (offset === raw.length) break;
    if (raw[offset++] !== "," || offset === raw.length) throw invalid();
  }
  return { servers, expires };
};
