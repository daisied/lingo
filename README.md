<p align="center">
  <img src="./images/lingo-header.png" alt="Lingo" width="400" />
</p>

<h1 align="center">Lingo</h1>
<p align="center">Language-learning plugin for Vencord with automatic chat translation, with support for 137+ languages.</p>

## Why

Reading real conversations in your target language is a fast way to build comprehension.
Lingo removes friction by translating as messages appear, so Discord becomes daily language practice.

## Screenshots

<table align="center">
  <tr>
    <td align="left">
      <img src="./images/lingo-message-view.png" alt="Lingo in chat" width="430" />
    </td>
    <td width="40"></td>
    <td align="right">
      <img src="./images/lingo-toggle-original.png" alt="Lingo original toggle" width="430" />
    </td>
  </tr>
  <tr>
    <td colspan="3" align="center">
      <img src="./images/lingo-settings.png" alt="Lingo settings" width="900" />
    </td>
  </tr>
</table>

## Quick Start

1. Open your Vencord checkout.
2. Copy this folder into Vencord userplugins:
   - From: `lingo`
   - To: `Vencord/src/userplugins/lingo`
3. Build Vencord:
   - `npm run build`
4. Inject/patch Discord:
   - `npm run inject -- --branch stable`
5. Fully restart Discord.
6. Enable `Lingo` in Vencord settings and set your target language.

## Notes

- `native.ts` is included for Azure Translator support.
- If Azure is unavailable, backend behavior follows your plugin settings (Azure-only or fallback mode).
- Vencord custom plugin docs: `https://docs.vencord.dev/installing/custom-plugins/`
