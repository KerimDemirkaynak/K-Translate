const CONFIG = {
    maxConcurrent: 3, batchMaxChars: 3500, batchMaxBlocks: 40, 
    batchSeparator: '\n\n|||\n\n', 
    inlineTags: new Set(['A','B','I','STRONG','EM','SPAN','MARK','SMALL','DEL','INS','SUB','SUP','CODE','Q','ABBR','BR','FONT'])
};

const LANG_MAP = {
    'tr': 'Türkçe', 'en': 'English', 'de': 'Deutsch', 'ja': '日本語', 
    'es': 'Español', 'fr': 'Français', 'ru': 'Русский', 'ko': '한국어', 
    'zh-CN': '中文 (Basit)', 'ar': 'العربية', 'pt': 'Português', 
    'it': 'Italiano', 'nl': 'Nederlands', 'pl': 'Polski'
};

const TRANSLATION_CACHE = new Map();
const ORIGINAL_HTML_MAP = new Map();

const STATE = {
    sourceLang: 'auto', detectedLang: null, targetLang: 'tr',
    blockedSites: [], blockedLangs: [],
    isActive: false, totalBlocks: 0, processedBlocks: 0, blockCounter: 0, observer: null
};

// ==========================================
// 1. DOM TARAYICI & MOTOR
// ==========================================
class HTMLMasker {
    static mask(htmlString) {
        const tagMap = {}; let counter = 0;
        const maskedHtml = htmlString.replace(/<[^>]+>/g, (match) => { 
            const id = `[#${counter}#]`; tagMap[id] = match; counter++; return id; 
        });
        return { maskedHtml, tagMap };
    }
    static unmask(translatedHtml, tagMap) {
        let unmasked = translatedHtml;
        for (const [id, originalTag] of Object.entries(tagMap)) {
            const numMatch = id.match(/\d+/);
            if(numMatch) { unmasked = unmasked.replace(new RegExp(`\\[\\s*#\\s*${numMatch[0]}\\s*#\\s*\\]`, 'g'), originalTag); }
        }
        return unmasked;
    }
}

class DOMScanner {
    static getContextualBlocks(root) {
        const blocks = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
            acceptNode: (node) => {
                if (node.id === 'kerim-ui-wrapper' || node.closest('#kerim-ui-wrapper')) return NodeFilter.FILTER_REJECT;
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SVG', 'CANVAS', 'PRE', 'CODE'].includes(node.tagName)) return NodeFilter.FILTER_REJECT;
                if (node.hasAttribute('data-v-translated') || node.closest('[data-v-translated]')) return NodeFilter.FILTER_REJECT;
                if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;

                let hasTextNode = false; let hasBlockChild = false;
                for (let child of node.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim().length > 0) hasTextNode = true;
                    else if (child.nodeType === Node.ELEMENT_NODE) {
                        if (!CONFIG.inlineTags.has(child.tagName.toUpperCase())) { hasBlockChild = true; break; }
                    }
                }
                return (hasTextNode && !hasBlockChild) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        let currentNode;
        while ((currentNode = walker.nextNode())) { 
            currentNode.setAttribute('data-v-translated', 'queued'); 
            blocks.push(currentNode); 
        }
        return blocks;
    }

    static startObserver() {
        if (STATE.observer) return;
        STATE.observer = new MutationObserver((mutations) => {
            if (!STATE.isActive) return;
            let newBlocks = [];
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE && node.id !== 'kerim-ui-wrapper') {
                        if (node.closest('[data-v-translated]')) return;
                        let isBlock = false;
                        if (node.textContent.trim()) {
                            let hasBlock = false;
                            for(let c of node.childNodes) { 
                                if(c.nodeType === Node.ELEMENT_NODE && !CONFIG.inlineTags.has(c.tagName)) hasBlock = true; 
                            }
                            if(!hasBlock) isBlock = true;
                        }
                        if (isBlock && !node.hasAttribute('data-v-translated')) {
                            node.setAttribute('data-v-translated', 'queued'); 
                            newBlocks.push(node);
                        } else { 
                            newBlocks.push(...this.getContextualBlocks(node)); 
                        }
                    }
                });
            });
            if (newBlocks.length > 0) { STATE.totalBlocks += newBlocks.length; queueManager.add(newBlocks); }
        });
        STATE.observer.observe(document.body, { childList: true, subtree: true });
    }

    static stopObserver() {
        if (STATE.observer) { STATE.observer.disconnect(); STATE.observer = null; }
    }
}

class QueueManager {
    constructor() { this.queue = []; this.activeCount = 0; }
    add(blocks) { this.queue.push(...blocks); this.process(); }
    
    async process() {
        if (this.queue.length === 0 || this.activeCount >= CONFIG.maxConcurrent || !STATE.isActive) return;
        let batchData = []; let currentCharCount = 0;

        while (this.queue.length > 0 && batchData.length < CONFIG.batchMaxBlocks && currentCharCount < CONFIG.batchMaxChars) {
            const block = this.queue.shift(); 
            if (!document.contains(block)) { STATE.processedBlocks++; continue; }

            const originalHtml = block.innerHTML.trim();
            if (!block.hasAttribute('data-k-id')) {
                const bId = (++STATE.blockCounter).toString();
                block.setAttribute('data-k-id', bId);
                ORIGINAL_HTML_MAP.set(bId, originalHtml);
            }

            if (!/[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/.test(originalHtml)) {
                block.setAttribute('data-v-translated', 'done'); STATE.processedBlocks++; continue;
            }
            if (TRANSLATION_CACHE.has(originalHtml)) {
                DOMScanner.stopObserver(); 
                block.innerHTML = TRANSLATION_CACHE.get(originalHtml); 
                block.setAttribute('data-v-translated', 'done'); 
                DOMScanner.startObserver(); 
                STATE.processedBlocks++; continue;
            }
            const { maskedHtml, tagMap } = HTMLMasker.mask(originalHtml);
            batchData.push({ block, maskedHtml, tagMap, originalHtml });
            currentCharCount += maskedHtml.length;
        }

        if (batchData.length === 0) { UIManager.updateProgress(); this.process(); return; }

        this.activeCount++;
        const textToTranslate = batchData.map(d => d.maskedHtml).join(CONFIG.batchSeparator);

        try {
            const response = await browser.runtime.sendMessage({
                action: "fetchTranslation", text: textToTranslate, sourceLang: STATE.sourceLang, targetLang: STATE.targetLang
            });

            if (response && response.success) {
                const translatedParts = response.text.split(/\|\|\|/g).map(s => s.trim());
                DOMScanner.stopObserver(); 

                if (translatedParts.length === batchData.length) {
                    batchData.forEach((d, i) => {
                        const unmasked = HTMLMasker.unmask(translatedParts[i], d.tagMap);
                        d.block.innerHTML = unmasked; 
                        d.block.setAttribute('data-v-translated', 'done'); 
                        TRANSLATION_CACHE.set(d.originalHtml, unmasked);
                    });
                } else {
                    for (let d of batchData) {
                        const singleRes = await browser.runtime.sendMessage({ action: "fetchTranslation", text: d.maskedHtml, sourceLang: STATE.sourceLang, targetLang: STATE.targetLang });
                        if(singleRes.success) {
                            const unmasked = HTMLMasker.unmask(singleRes.text, d.tagMap);
                            d.block.innerHTML = unmasked; 
                            d.block.setAttribute('data-v-translated', 'done'); 
                            TRANSLATION_CACHE.set(d.originalHtml, unmasked);
                        } else d.block.setAttribute('data-v-translated', 'error');
                    }
                }
                DOMScanner.startObserver(); 
            } else batchData.forEach(d => d.block.setAttribute('data-v-translated', 'error')); 
        } catch (err) { 
            batchData.forEach(d => d.block.setAttribute('data-v-translated', 'error')); 
        } finally { 
            STATE.processedBlocks += batchData.length; 
            UIManager.updateProgress();
            this.activeCount--; 
            this.process(); 
        }
    }
}
const queueManager = new QueueManager();

// ==========================================
// 2. SAYFA İÇİ ARAYÜZ (GHOST UI)
// ==========================================
class UIManager {
    static isVisible = false;

    static msg(key) {
        return browser.i18n.getMessage(key) || key;
    }

    static init() {
        if (document.getElementById('kerim-ui-wrapper')) return;
        
        const style = document.createElement('style');
        style.textContent = `
            #kerim-ui-wrapper { all: initial; position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: center; z-index: 2147483647; pointer-events: none; font-family: sans-serif; }
            #kerim-panel { pointer-events: auto; background: #202124; border: 1px solid #3c4043; border-top: none; border-radius: 0 0 12px 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.6); width: 92%; max-width: 440px; transform: translateY(-100%); transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease; opacity: 0; overflow: hidden; }
            #kerim-panel.visible { transform: translateY(0); opacity: 1; }
            #kerim-main-view { display: flex; flex-direction: column; }
            .kerim-lang-row { display: flex; align-items: center; padding: 10px 12px 4px; justify-content: space-between; gap: 8px; }
            .kerim-lang-select { flex: 1; background: #3c4043; color: #fff; border: none; padding: 8px; border-radius: 6px; outline: none; font-size: 13px; cursor: pointer; }
            .kerim-arrow { color: #9aa0a6; font-size: 14px; display: flex; align-items: center; }
            .kerim-divider { height: 1px; background: #3c4043; margin: 4px 12px; }
            .kerim-action-row { display: flex; align-items: center; padding: 4px 8px 8px; gap: 4px; }
            .kerim-action-btn { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 8px 10px; border-radius: 6px; font-size: 13px; display: flex; align-items: center; gap: 6px; }
            .kerim-action-btn:hover { background: #3c4043; }
            .kerim-action-btn.primary { color: #8ab4f8; margin-left: auto; font-weight: bold; }
            #kerim-progress { height: 2px; background: transparent; position: relative; overflow: hidden; }
            #kerim-progress-fill { height: 100%; width: 0%; background: #8ab4f8; transition: width 0.3s ease; position: absolute; top: 0; left: 0; }
            
            #kerim-adv-view { display: none; padding: 10px; flex-direction: column; gap: 8px; }
            .kerim-adv-btn { background: #3c4043; color: #f28b82; border: none; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
            .kerim-adv-btn:hover { background: rgba(242,139,130,0.2); }
            
            #kerim-trigger { pointer-events: auto; position: fixed; bottom: 20px; right: 20px; width: 46px; height: 46px; background: #000000; border: 1px solid #3c4043; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 2147483646; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: transform 0.3s, opacity 0.3s; }
            #kerim-trigger.hidden { transform: scale(0); opacity: 0; pointer-events: none; }
        `;
        document.head.appendChild(style);

        const autoText = navigator.language.startsWith('tr') ? 'Otomatik Algıla' : 'Auto Detect';

        const wrapper = document.createElement('div'); wrapper.id = 'kerim-ui-wrapper';
        wrapper.innerHTML = `
            <div id="kerim-panel">
                <div id="kerim-main-view">
                    <div class="kerim-lang-row">
                        <select id="kerim-source-select" class="kerim-lang-select" title="Kaynak Dil">
                            <option value="auto">${autoText}</option>
                            ${Object.entries(LANG_MAP).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
                        </select>
                        <span class="kerim-arrow">➔</span>
                        <select id="kerim-target-select" class="kerim-lang-select" title="Hedef Dil">
                            ${Object.entries(LANG_MAP).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
                        </select>
                    </div>
                    <div id="kerim-progress"><div id="kerim-progress-fill"></div></div>
                    <div class="kerim-divider"></div>
                    <div class="kerim-action-row">
                        <button class="kerim-action-btn" id="kerim-adv-toggle">⚙️ ${this.msg('advancedOptions') || 'Settings'}</button>
                        <button class="kerim-action-btn" id="kerim-undo-btn">${this.msg('btnRevert') || 'Revert'}</button>
                        <button class="kerim-action-btn primary" id="kerim-translate-btn">${this.msg('btnTranslate') || 'Translate'}</button>
                    </div>
                </div>
                <div id="kerim-adv-view">
                    <button class="kerim-adv-btn" id="kerim-never-site">${this.msg('optNeverSite') || 'Never for this site'}</button>
                    <button class="kerim-adv-btn" id="kerim-never-lang">${this.msg('optNeverLang') || 'Never for this language'}</button>
                </div>
            </div>
            <div id="kerim-trigger" class="hidden">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#8ab4f8"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>
            </div>
        `;
        document.documentElement.appendChild(wrapper);

        // Event Dinleyicileri
        document.getElementById('kerim-source-select').value = STATE.sourceLang;
        document.getElementById('kerim-source-select').onchange = (e) => {
            STATE.sourceLang = e.target.value;
            if(STATE.isActive) { Controller.revert(); Controller.start(); }
        };

        document.getElementById('kerim-target-select').value = STATE.targetLang;
        document.getElementById('kerim-target-select').onchange = (e) => {
            STATE.targetLang = e.target.value;
            browser.storage.local.set({ targetLang: STATE.targetLang });
            if(STATE.isActive) { Controller.revert(); Controller.start(); }
        };

        document.getElementById('kerim-translate-btn').onclick = () => Controller.start();
        document.getElementById('kerim-undo-btn').onclick = () => Controller.revert();
        document.getElementById('kerim-trigger').onclick = () => this.toggle(true);
        
        let advOpen = false;
        document.getElementById('kerim-adv-toggle').onclick = () => {
            advOpen = !advOpen;
            document.getElementById('kerim-adv-view').style.display = advOpen ? 'flex' : 'none';
        };

        document.getElementById('kerim-never-site').onclick = () => {
            const host = window.location.hostname;
            if(!STATE.blockedSites.includes(host)) STATE.blockedSites.push(host);
            browser.storage.local.set({ blockedSites: STATE.blockedSites });
            this.toggle(false); document.getElementById('kerim-trigger').classList.add('hidden');
        };

        document.getElementById('kerim-never-lang').onclick = () => {
            if(STATE.detectedLang && !STATE.blockedLangs.includes(STATE.detectedLang)) STATE.blockedLangs.push(STATE.detectedLang);
            browser.storage.local.set({ blockedLangs: STATE.blockedLangs });
            this.toggle(false); document.getElementById('kerim-trigger').classList.add('hidden');
        };
        
        // Scroll ile paneli gizle
        let lastScrollY = window.scrollY;
        window.addEventListener('scroll', () => {
            if (!this.isVisible) return;
            if (window.scrollY > lastScrollY + 40) this.toggle(false);
            lastScrollY = window.scrollY;
        }, { passive: true });
    }

    static toggle(force) {
        const panel = document.getElementById('kerim-panel');
        const trigger = document.getElementById('kerim-trigger');
        if (!panel) return;

        const isNative = (STATE.detectedLang === STATE.targetLang || STATE.blockedLangs.includes(STATE.detectedLang) || STATE.blockedSites.includes(window.location.hostname));

        if (force === true) {
            panel.classList.add('visible'); trigger.classList.add('hidden'); this.isVisible = true;
        } else if (force === false) {
            panel.classList.remove('visible');
            if(!isNative) trigger.classList.remove('hidden');
            this.isVisible = false;
        } else {
            this.isVisible = !this.isVisible;
            panel.classList.toggle('visible', this.isVisible);
            if (this.isVisible || isNative) trigger.classList.add('hidden');
            else trigger.classList.remove('hidden');
        }
    }

    static updateProgress() {
        const fill = document.getElementById('kerim-progress-fill');
        if (!fill) return;
        if (STATE.totalBlocks === 0) { fill.style.width = '0%'; return; }
        const pct = Math.min(100, Math.round((STATE.processedBlocks / STATE.totalBlocks) * 100));
        fill.style.width = `${pct}%`;
        if (pct >= 100) setTimeout(() => fill.style.width = '0%', 1500);
    }
}

// ==========================================
// 3. KONTROLCÜ
// ==========================================
class Controller {
    static async init() {
        // Tarayıcının sistem dilini çek. Desteklemiyorsak İngilizce yap.
        let sysLang = navigator.language.split('-')[0];
        if (!LANG_MAP[sysLang]) sysLang = 'en';

        // Önceden kaydedilmiş hedef dili al, yoksa sistem dilini varsayılan yap
        const res = await browser.storage.local.get({ targetLang: sysLang, blockedSites: [], blockedLangs: [] });
        STATE.targetLang = res.targetLang;
        STATE.blockedSites = res.blockedSites;
        STATE.blockedLangs = res.blockedLangs;

        if (STATE.blockedSites.includes(window.location.hostname)) return;

        let fallbackLang = document.documentElement.lang ? document.documentElement.lang.split('-')[0].toLowerCase() : 'auto';
        STATE.detectedLang = fallbackLang;
        STATE.sourceLang = 'auto'; // Kaynak her zaman otomatik başlasın

        UIManager.init();

        if (!STATE.blockedLangs.includes(fallbackLang) && fallbackLang !== STATE.targetLang) {
            UIManager.toggle(false); // Paneli kapalı, FAB'ı açık başlat
        }
    }

    static start() {
        if (STATE.isActive) return;
        STATE.isActive = true;
        UIManager.toggle(false); // Çeviri başlayınca paneli kapat
        
        const initialBlocks = DOMScanner.getContextualBlocks(document.body);
        STATE.totalBlocks = initialBlocks.length;
        STATE.processedBlocks = 0;
        if (initialBlocks.length > 0) queueManager.add(initialBlocks);
        DOMScanner.startObserver();
    }

    static revert() {
        STATE.isActive = false;
        DOMScanner.stopObserver();
        queueManager.queue = [];
        
        document.querySelectorAll('[data-v-translated]').forEach(node => {
            const bId = node.getAttribute('data-k-id');
            if (bId && ORIGINAL_HTML_MAP.has(bId)) node.innerHTML = ORIGINAL_HTML_MAP.get(bId);
            node.removeAttribute('data-v-translated');
        });

        STATE.totalBlocks = 0; STATE.processedBlocks = 0;
        UIManager.updateProgress();
    }
}

if (document.readyState === 'complete') Controller.init();
else window.addEventListener('load', () => Controller.init(), { once: true });