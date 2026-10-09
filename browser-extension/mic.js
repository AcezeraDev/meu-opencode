/**
 * The side panel cannot show the browser's microphone prompt; this tab of the
 * extension can. Once allowed here, the whole extension (and so the panel) may
 * record, and this tab closes itself.
 */
async function ask() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => undefined)
  if (!stream) {
    document.getElementById("title").textContent = "O microfone ficou bloqueado"
    document.getElementById("text").textContent =
      "Clique no cadeado ao lado do endereço, permita o microfone e clique em Pedir de novo."
    return
  }
  for (const track of stream.getTracks()) track.stop()
  document.getElementById("title").textContent = "Pronto! Pode ditar no painel"
  document.getElementById("text").textContent = "Esta aba fecha sozinha."
  document.getElementById("again").hidden = true
  setTimeout(() => window.close(), 1500)
}
document.getElementById("again").addEventListener("click", ask)
void ask()
