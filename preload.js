const { contextBridge } = require('electron');

// Expose an empty API for future use. Keeping this file minimal maintains
// security by disabling node integration in the renderer process while
// still allowing a place to add APIs if needed later.
contextBridge.exposeInMainWorld('api', {});
