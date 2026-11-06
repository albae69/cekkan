import assert from "node:assert/strict";
import {
  addNode,
  blankDoc,
  buildUrl,
  curlOf,
  importHttpie,
  importPostman,
  kv,
  parseEnv,
  removeNode,
  requestHeaders,
  subst,
  updateNode,
  urlencodedBody,
} from "../src/model.ts";

const vars = parseEnv("base_url=https://api.test\n# skip\ntoken=abc=def");
assert.deepEqual(vars, { base_url: "https://api.test", token: "abc=def" });
assert.equal(subst("{{base_url}}/x/{{token}}/{{nope}}", vars), "https://api.test/x/abc=def/{{nope}}");

const doc = blankDoc();
doc.url = "{{base_url}}/users";
doc.params = [kv("q", "a b"), kv("off", "x", false)];
doc.auth = { ...doc.auth, type: "apikey", apiKey: "api_key", apiValue: "s3cret", apiIn: "query" };
assert.equal(buildUrl(doc, (s) => subst(s, vars)), "https://api.test/users?q=a%20b&api_key=s3cret");

doc.headers = [kv("Accept", "application/json")];
doc.auth = { ...doc.auth, type: "bearer", token: "{{token}}" };
let h = requestHeaders(doc, (s) => subst(s, vars), "application/json");
assert.equal(h.Authorization, "Bearer abc=def");
assert.equal(h["Content-Type"], "application/json");

doc.auth = { ...doc.auth, type: "basic", username: "u", password: "p" };
h = requestHeaders(doc, (s) => subst(s, vars));
assert.equal(h.Authorization, "Basic dTpw");

doc.bodyMode = "urlencoded";
doc.formRows = [kv("a", "1"), kv("f", "/tmp/x.png"), { ...kv("f", "/tmp/x.png"), file: true }];
assert.equal(urlencodedBody(doc, (s) => s), "a=1&f=%2Ftmp%2Fx.png");

doc.bodyMode = "raw";
doc.rawType = "json";
doc.rawBody = '{"a":1}';
doc.method = "POST";
doc.auth = { ...doc.auth, type: "none" };
const curl = curlOf(doc, (s) => subst(s, vars));
assert.match(curl, /^curl -X POST 'https:\/\/api\.test\/users\?q=a%20b'/);
assert.match(curl, /--data-raw '\{"a":1\}'/);

const imported = importPostman({
  info: { name: "Pm" },
  item: [
    {
      name: "Folder",
      item: [
        {
          name: "Login",
          request: {
            method: "POST",
            url: { raw: "https://x.test/login", query: [{ key: "v", value: "1" }] },
            header: [{ key: "X-Y", value: "z" }],
            body: { mode: "formdata", formdata: [{ key: "file", type: "file", src: "/tmp/a.bin" }] },
            auth: { type: "bearer", bearer: [{ key: "token", value: "t" }] },
          },
        },
      ],
    },
  ],
});
const req = imported[0].children[0].children[0];
assert.equal(req.type, "request");
assert.equal(req.request.auth.token, "t");
assert.equal(req.request.formRows[0].file, true);
assert.equal(req.request.formRows[0].value, "/tmp/a.bin");
assert.equal(req.request.params[0].key, "v");

const httpie = importHttpie({
  entry: {
    name: "RME",
    auth: { type: "none" },
    requests: [
      {
        name: "Login",
        url: "http://localhost:8282/login",
        method: "POST",
        headers: [{ name: "X-Y", value: "z", enabled: true }],
        queryParams: [{ name: "v", value: "1", enabled: true }],
        pathParams: [],
        auth: { type: "bearer", credentials: { username: "", password: "tok" } },
        body: { type: "text", text: { value: '{"a":1}', format: "application/json" } },
      },
      {
        name: "Upload",
        url: "http://x.test/up",
        method: "POST",
        headers: [],
        queryParams: [],
        pathParams: [],
        auth: { type: "inherited" },
        body: {
          type: "form",
          form: {
            isMultipart: true,
            fields: [
              { name: "imageUrl", value: "", enabled: true, type: "file" },
              { name: "noReg", value: "1", enabled: true, type: "text" },
            ],
          },
        },
      },
      { name: "Group", requests: [] },
      { name: "", url: "", method: "GET" },
    ],
  },
});
assert.equal(httpie[0].name, "RME");
assert.equal(httpie[0].children.length, 3);
const login = httpie[0].children[0];
assert.equal(login.request.auth.token, "tok");
assert.equal(login.request.rawBody, '{"a":1}');
assert.equal(login.request.params[0].key, "v");
const upload = httpie[0].children[1];
assert.equal(upload.request.bodyMode, "form");
assert.equal(upload.request.auth.type, "none");
assert.equal(upload.request.formRows[0].file, true);

const folder = { id: "f", name: "F", type: "folder", children: [] };const leaf = { id: "r", name: "R", type: "request", request: blankDoc() };
let tree = addNode([folder], "f", leaf);
assert.equal(tree[0].children.length, 1);
tree = updateNode(tree, "r", (n) => ({ ...n, name: "R2" }));
assert.equal(tree[0].children[0].name, "R2");
tree = removeNode(tree, "r");
assert.equal(tree[0].children.length, 0);

console.log("model checks ok");
