// V0.3 stores article metadata in chrome.storage.local and image blobs in IndexedDB.
const STORAGE_KEY = "savedPages";
const MAX_PAGES = 30;
const MAX_TEXT_LENGTH = 20000;
const MAX_IMAGES_PER_PAGE = 20;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_DB_NAME = "saveWhatYouLikeImages";
const IMAGE_STORE_NAME = "images";

const saveButton = document.getElementById("saveButton");
const statusLine = document.getElementById("status");
const savedList = document.getElementById("savedList");

function showStatus(message) { statusLine.textContent = message; }

async function getPages() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

function openImageDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(IMAGE_STORE_NAME, { keyPath: "id" });
      store.createIndex("pageId", "pageId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putImage(record) {
  const database = await openImageDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(IMAGE_STORE_NAME).put(record);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

async function getImagesForPage(pageId) {
  const database = await openImageDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, "readonly");
    const request = transaction.objectStore(IMAGE_STORE_NAME).index("pageId").getAll(pageId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  });
}

async function deleteImagesForPage(pageId) {
  const database = await openImageDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, "readwrite");
    const request = transaction.objectStore(IMAGE_STORE_NAME).index("pageId").openCursor(IDBKeyRange.only(pageId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

async function deleteImagesForPages(pages) {
  await Promise.all(pages.map(page => deleteImagesForPage(page.id)));
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

function makeButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function renderArticle(page, container) {
  container.replaceChildren();
  const blocks = Array.isArray(page.contentBlocks) ? page.contentBlocks : [];
  if (blocks.length === 0) {
    container.textContent = page.text;
    return;
  }

  let imagesByKey = new Map();
  try {
    imagesByKey = new Map((await getImagesForPage(page.id)).map(image => [image.imageKey, image]));
  } catch (error) {
    console.warn("Could not load locally saved images.", error);
  }

  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      const paragraph = document.createElement("p");
      paragraph.className = "articleParagraph";
      paragraph.textContent = block.text;
      container.append(paragraph);
    } else if (block.type === "image") {
      const storedImage = imagesByKey.get(block.imageKey);
      if (!storedImage?.blob) continue;
      const image = document.createElement("img");
      image.className = "savedImage";
      image.alt = block.alt || "文章图片";
      const objectUrl = URL.createObjectURL(storedImage.blob);
      image.src = objectUrl;
      image.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
      image.addEventListener("error", () => URL.revokeObjectURL(objectUrl), { once: true });
      container.append(image);
    }
  }
}

async function renderPages() {
  const pages = await getPages();
  savedList.replaceChildren();
  if (pages.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty";
    hint.textContent = "还没有收藏。打开一篇文章试试吧！";
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
    articleText.hidden = true;

    const viewButton = makeButton("查看文字", async () => {
      if (articleText.hidden) {
        viewButton.disabled = true;
        await renderArticle(page, articleText);
        articleText.hidden = false;
        viewButton.textContent = "收起文字";
        viewButton.disabled = false;
      } else {
        articleText.hidden = true;
        viewButton.textContent = "查看文字";
      }
    });
    const deleteButton = makeButton("删除", async () => {
      const current = await getPages();
      await chrome.storage.local.set({ [STORAGE_KEY]: current.filter(p => p.id !== page.id) });
      try { await deleteImagesForPage(page.id); } catch (error) { console.warn("Could not remove images.", error); }
      showStatus("已从本地删除。");
      await renderPages();
    });
    actions.append(viewButton, deleteButton);
    item.append(title, meta, actions, articleText);
    savedList.append(item);
  }
}

async function fetchImageData(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (imageUrl, maxBytes) => {
      try {
        const response = await fetch(imageUrl, { credentials: "same-origin" });
        if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) return { ok: false, reason: "图片超过大小限制" };
        const blob = await response.blob();
        if (blob.size > maxBytes) return { ok: false, reason: "图片超过大小限制" };
        if (blob.type && !blob.type.startsWith("image/")) return { ok: false, reason: "不是可保存的图片" };
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { ok: true, dataUrl, contentType: blob.type, size: blob.size };
      } catch (error) {
        return { ok: false, reason: error.message || "无法读取图片" };
      }
    },
    args: [url, MAX_IMAGE_BYTES]
  });
  return results?.[0]?.result ?? { ok: false, reason: "无法读取图片" };
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  showStatus("正在提取文章正文……");
  let newPageId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url ?? "")) {
      throw new Error("请先打开普通网页（http/https），再点击收藏。");
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["vendor/Readability.js"]
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (textLimit, imageLimit) => {
        const fallback = () => {
          const root = document.querySelector("article") || document.querySelector("main") || document.body;
          return { title: document.title || "无标题", url: location.href, text: (root?.innerText || "").trim().slice(0, textLimit), contentBlocks: [], images: [], imageCount: 0 };
        };
        const toUrl = rawUrl => {
          if (!rawUrl) return null;
          try {
            const url = new URL(rawUrl.trim(), location.href);
            return /^(https?:|data:)/.test(url.protocol) ? url.href : null;
          } catch { return null; }
        };
        const bestSrcset = srcset => {
          if (!srcset) return null;
          let best = null;
          let score = -1;
          for (const entry of srcset.split(",").map(value => value.trim()).filter(Boolean)) {
            const [url, descriptor] = entry.split(/\s+/, 2);
            const nextScore = Number.parseFloat(descriptor) || 1;
            if (nextScore >= score) { best = url; score = nextScore; }
          }
          return best;
        };
        const getImageUrl = image => toUrl(
          image.currentSrc ||
          image.getAttribute("data-src") ||
          image.getAttribute("data-original") ||
          image.getAttribute("data-lazy-src") ||
          bestSrcset(image.getAttribute("srcset")) ||
          image.getAttribute("src")
        );
        const makeBlocks = contentHtml => {
          const parsed = new DOMParser().parseFromString(contentHtml, "text/html");
          const blocks = [];
          const images = [];
          let imageCount = 0;
          let remainingText = textLimit;
          const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
          const addText = value => {
            const text = value.replace(/\s+/g, " ").trim();
            if (!text || remainingText <= 0) return;
            const limitedText = text.slice(0, remainingText);
            remainingText -= limitedText.length;
            const previous = blocks.at(-1);
            if (previous?.type === "text") previous.text += `\n${limitedText}`;
            else blocks.push({ type: "text", text: limitedText });
          };
          const walk = node => {
            if (node.nodeType === Node.TEXT_NODE) { addText(node.nodeValue || ""); return; }
            if (node.nodeType !== Node.ELEMENT_NODE || ignoredTags.has(node.tagName)) return;
            if (node.tagName === "IMG") {
              const url = getImageUrl(node);
              if (!url) return;
              imageCount += 1;
              if (images.length >= imageLimit) return;
              const imageKey = `image-${images.length}`;
              const alt = node.getAttribute("alt") || "";
              images.push({ imageKey, url, alt });
              blocks.push({ type: "image", imageKey, alt });
              return;
            }
            for (const child of node.childNodes) walk(child);
          };
          for (const child of parsed.body.childNodes) walk(child);
          return { blocks, images, imageCount };
        };
        try {
          const article = new Readability(document.cloneNode(true)).parse();
          const text = (article?.textContent || "").trim();
          if (text) {
            const imageData = makeBlocks(article.content || "");
            return {
              title: (article.title || document.title || "无标题").trim(),
              url: location.href,
              text: text.slice(0, textLimit),
              contentBlocks: imageData.blocks,
              images: imageData.images,
              imageCount: imageData.imageCount
            };
          }
        } catch (error) {
          console.warn("Readability failed; using the basic text extractor.", error);
        }
        return fallback();
      },
      args: [MAX_TEXT_LENGTH, MAX_IMAGES_PER_PAGE]
    });
    const captured = results?.[0]?.result;
    if (!captured?.text) throw new Error("没有找到可保存的文字，请换一篇普通文章试试。");

    newPageId = crypto.randomUUID();
    const savedImages = [];
    const attemptedImageCount = captured.images.length;
    if (attemptedImageCount > 0) showStatus(`正在保存图片…… 0/${attemptedImageCount}`);
    for (let index = 0; index < attemptedImageCount; index += 1) {
      const image = captured.images[index];
      try {
        const result = await fetchImageData(tab.id, image.url);
        if (result.ok) {
          const blob = await dataUrlToBlob(result.dataUrl);
          await putImage({ id: `${newPageId}:${image.imageKey}`, pageId: newPageId, imageKey: image.imageKey, blob, contentType: result.contentType, size: result.size });
          savedImages.push({ imageKey: image.imageKey, url: image.url, alt: image.alt });
        } else console.warn(`Skipped image ${image.url}: ${result.reason}`);
      } catch (error) {
        console.warn(`Skipped image ${image.url}:`, error);
      }
      showStatus(`正在保存图片…… ${savedImages.length}/${attemptedImageCount}`);
    }

    const previous = await getPages();
    const page = {
      id: newPageId, title: captured.title, url: captured.url, text: captured.text, savedAt: Date.now(),
      contentBlocks: captured.contentBlocks, images: savedImages,
      imageCount: { found: captured.imageCount, attempted: attemptedImageCount, saved: savedImages.length }
    };
    const updated = [page, ...previous.filter(p => p.url !== captured.url)].slice(0, MAX_PAGES);
    const savedPageIds = new Set(updated.map(savedPage => savedPage.id));
    const removedPages = previous.filter(previousPage => !savedPageIds.has(previousPage.id));
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    } catch (error) {
      await deleteImagesForPage(newPageId);
      throw error;
    }
    await deleteImagesForPages(removedPages);
    const imageSummary = captured.imageCount === 0
      ? "没有发现正文图片。"
      : savedImages.length === attemptedImageCount && attemptedImageCount === captured.imageCount
        ? `图片：${savedImages.length}/${captured.imageCount} 张。`
        : `图片：${savedImages.length}/${attemptedImageCount} 张成功（正文发现 ${captured.imageCount} 张；最多处理 ${MAX_IMAGES_PER_PAGE} 张）。`;
    showStatus(`✅ 已保存到本地！正文：${captured.text.length} 字。${imageSummary}`);
    await renderPages();
  } catch (error) {
    if (newPageId) {
      try { await deleteImagesForPage(newPageId); } catch (cleanupError) { console.warn(cleanupError); }
    }
    console.error(error);
    showStatus(`保存失败：${error.message || "当前网页无法读取"}`);
  } finally {
    saveButton.disabled = false;
  }
});

renderPages().catch(error => showStatus(`读取收藏失败：${error.message}`));
