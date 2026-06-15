browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchTranslation") {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${request.sourceLang}&tl=${request.targetLang}&dt=t`;
        
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: "q=" + encodeURIComponent(request.text)
        })
        .then(res => res.text())
        .then(responseText => {
            const data = JSON.parse(responseText);
            let translated = "";
            if (data && data[0]) {
                data[0].forEach(item => { if (item[0]) translated += item[0]; });
            }
            sendResponse({ success: true, text: translated });
        })
        .catch(err => {
            console.error("K-Translate API Error:", err);
            sendResponse({ success: false, error: err.toString() });
        });
        
        return true; 
    }
});