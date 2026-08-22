const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-gateway-"));
process.env.DATA_DIR = dataDirectory;
process.env.TARGET_API_URL = "https://gateway-test.invalid/v1/chat/completions";
process.env.TARGET_API_KEY = "test-key";

const { app } = require("../server");

test.after(async () => {
  await app.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("普通文本和多模态聊天请求不会在消息摘要阶段返回 500", async () => {
  const originalFetch = global.fetch;
  const forwardedRequests = [];
  global.fetch = async (_, options) => {
    forwardedRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const textResponse = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "test-model",
        stream: false,
        messages: [{ role: "user", content: "普通文本消息" }]
      }
    });
    assert.equal(textResponse.statusCode, 200);

    const multimodalContent = [
      { type: "text", text: "带图片的消息" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }
    ];
    const multimodalResponse = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "test-model",
        stream: false,
        messages: [{ role: "user", content: multimodalContent }]
      }
    });
    assert.equal(multimodalResponse.statusCode, 200);
    assert.equal(forwardedRequests.length, 2);
    assert.equal(forwardedRequests[0].messages[0].content, "普通文本消息");
    assert.deepEqual(forwardedRequests[1].messages[0].content, multimodalContent);
  } finally {
    global.fetch = originalFetch;
  }
});
