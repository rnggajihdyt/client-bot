// Small send helpers on top of client.message.send.
import { proto } from 'zapo-js'

// Send up to 3 quick-reply buttons.
export function sendButtons(client, jid, { text, footer, buttons = [] }, options = {}) {
  return client.message.send(jid, {
    buttonsMessage: {
      contentText: text,
      footerText: footer,
      headerType: proto.Message.ButtonsMessage.HeaderType.TEXT,
      text,
      buttons: buttons.map(({ id = 'b', label, type = proto.Message.ButtonsMessage.Button.Type.RESPONSE }) => ({
        buttonId: id,
        buttonText: { displayText: label },
        type,
      })),
    },
  }, options)
}

// Send media (image/video/audio/document/sticker) from a file path or stream.
// Prefer a file path string over a Buffer to keep memory flat.
export function sendMedia(client, jid, { type, media, mimetype, caption, fileName }, options = {}) {
  return client.message.send(jid, {
    type,
    media,
    mimetype,
    caption,
    fileName,
  }, options)
}
