// V0.1: the content stays in this browser's chrome.storage.local.
// No upload, remote server or background collection.
const STORAGE_KEY = "savedPages";
const MAX_PAGES = 30;
const MAX_TEXT_LENGTH = 20000;

const saveButton = document.getElementById("saveButton");
const statusLine = document.getElementById("status");
const savedList = document.getElementById("savedList");

function showStatus(message) {
  statusLine.textContent = message;
}

async function getPages() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

function makeButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function renderPages() {
  const pages = await getPages();
  savedList.replaceChildren();

  if (pages.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty";
    hint.textContent = "还没有收藏。打开一个网页试试吧！";
    savedList.append(hint);
    return;
  }

  for (const page of pages) {
    const item = document.createElement("section");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = page.title;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${new Date(page.savedAt).toLocaleString()} · ${page.url}`;

    const actions = document.createElement("div");
    actions.className = "actions";

    const articleText = document.createElement("div");
    articleText.className = "articleText";
    articleText.textContent = page.text;
    articleText.hidden = true;

    const viewButton = makeButton("查看文字", () => {
      articleText.hidden = !articleText.hidden;
      viewButton.textContent = articleText.hidden ? "查看文字" : "收起文字";
    });

    const deleteButton = makeButton("删除", async () => {
      const current = await getPages();
      await chrome.storage.local.set({
        [STORAGE_KEY]: current.filter(p => p.id !== page.id)
      });
      showStatus("已从本地删除。");
      await renderPages();
    });

    actions.append(viewButton, deleteButton);
    item.append(title, meta, actions, articleText);
    savedList.append(item);
  }
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  showStatus("正在提取文章正文……");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url ?? "")) {
      throw new Error("请先打开普通网页（http/https），再点击收藏。");
    }

    // Runs only after the user presses the button, in the current tab.
    // Readability.js is a packaged local dependency, so collection never needs a CDN.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["vendor/Readability.js"]
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (limit) => {
        const fallback = () => {
          const root =
            document.querySelector("article") ||
            document.querySelector("main") ||
            document.body;

          return {
            title: document.title || "无标题",
            url: location.href,
            text: (root?.innerText || "").trim().slice(0, limit)
          };
        };

        try {
          // Parse a copy so Readability never changes the live page DOM.
          const article = new Readability(document.cloneNode(true)).parse();
          const text = (article?.textContent || "").trim();
          if (text) {
            return {
              title: (article.title || document.title || "无标题").trim(),
              url: location.href,
              text: text.slice(0, limit)
            };
          }
        } catch (error) {
          console.warn("Readability failed; using the basic text extractor.", error);
        }

        return fallback();
      },
      args: [MAX_TEXT_LENGTH]
    });

    const captured = results?.[0]?.result;
    if (!captured?.text) {
      throw new Error("没有找到可保存的文字，请换一篇普通文章试试。");
    }

    const previous = await getPages();
    const withoutDuplicate = previous.filter(p => p.url !== captured.url);
    const updated = [
      { ...captured, id: crypto.randomUUID(), savedAt: Date.now() },
      ...withoutDuplicate
    ].slice(0, MAX_PAGES);

    await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    showStatus("✅ 已保存到本地！可以断网后查看文字。");
    await renderPages();
  } catch (error) {
    console.error(error);
    showStatus(`保存失败：${error.message || "当前网页无法读取"}`);
  } finally {
    saveButton.disabled = false;
  }
});

renderPages().catch(error => showStatus(`读取收藏失败：${error.message}`));
