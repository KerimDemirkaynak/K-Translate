document.addEventListener("DOMContentLoaded", () => {
    // 1. Dil dosyalarından metinleri çek (i18n)
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const msg = browser.i18n.getMessage(el.getAttribute('data-i18n'));
        if (msg) el.textContent = msg;
    });

    const statusEl = document.getElementById('status');
    const targetLangSelect = document.getElementById('targetLang');

    // Başarı mesajı gösterme fonksiyonu
    function showStatus(msgKey) {
        statusEl.textContent = browser.i18n.getMessage(msgKey) || msgKey;
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }

    // 2. Mevcut varsayılan dili yükle
    browser.storage.local.get(['targetLang']).then(res => {
        if (res.targetLang) {
            targetLangSelect.value = res.targetLang;
        }
    });

    // 3. Yeni dil seçildiğinde kaydet
    targetLangSelect.addEventListener('change', async (e) => {
        await browser.storage.local.set({ targetLang: e.target.value });
        showStatus('statusSaved');
    });

    // 4. Engellenen Siteleri Temizle
    document.getElementById('clearSites').addEventListener('click', async () => {
        await browser.storage.local.set({ blockedSites: [] });
        showStatus('statusCleared');
    });

    // 5. Engellenen Dilleri Temizle
    document.getElementById('clearLangs').addEventListener('click', async () => {
        await browser.storage.local.set({ blockedLangs: [] });
        showStatus('statusCleared');
    });
});