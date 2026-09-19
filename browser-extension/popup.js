const portInput = document.getElementById("port")
const tokenInput = document.getElementById("token")
const led = document.getElementById("led")
const state = document.getElementById("state")

chrome.storage.local.get(["port", "token"]).then(({ port, token }) => {
  if (port) portInput.value = port
  if (token) tokenInput.value = token
})

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    port: Number(portInput.value) || 4919,
    token: tokenInput.value.trim(),
  })
  refresh()
})

/** Asks the service worker whether its socket is open. */
async function refresh() {
  let connected = false
  try {
    connected = await chrome.runtime.sendMessage({ type: "status" })
  } catch {
    connected = false
  }
  led.toggleAttribute("data-on", connected === true)
  state.textContent = connected === true ? "conectado" : "desconectado"
}

refresh()
setInterval(refresh, 1500)
