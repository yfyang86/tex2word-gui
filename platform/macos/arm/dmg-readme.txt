Tex Word Studio @APP_VERSION@ (macOS, Apple silicon)
=====================================================

Install
  Drag "Tex Word Studio" into the Applications folder (or run it from
  anywhere — nothing is installed outside the app bundle).

First launch
  The app is not notarized with Apple. The first time you open it, macOS
  may say it "can't be verified" / is "damaged". To proceed:
    System Settings -> Privacy & Security -> scroll to the blocked-app
    notice -> "Open Anyway"  (once per download).
  On older macOS versions: right-click the app -> "Open".

Using it
  Launching the app starts a local server bound to 127.0.0.1 (your machine
  only) and opens it in your default browser. Quit the server from the
  Dock icon (right-click -> Quit). Launching again just opens a new tab.

  Your data (projects, chats, provider settings, converted files) is kept in
    ~/Library/Application Support/TexWordStudio/
  Delete that folder to start fresh; delete the app to uninstall.

  The tex-copilot assistant needs an API key: add a provider inside the app
  (top-right settings) — keys are encrypted at rest.

  Optional: converting inline TikZ figures to the preview needs a TeX engine
  (e.g. MacTeX or BasicTeX) installed with xelatex/pdflatex on PATH. The app
  itself — LaTeX -> Word conversion, preview, editor — needs nothing else.

Full documentation: see the project README.
