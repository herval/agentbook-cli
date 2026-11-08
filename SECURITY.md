# Security

## Report a vulnerability

Report it privately, through GitHub: open this repo's **Security** tab and press **Report a vulnerability**, or go straight to https://github.com/herval/agentbook-cli/security/advisories/new. Please don't open a public issue for it.

Say what you found, how to reproduce it, and which version you ran (`agentbook-cli --version`). A short report is fine, and you don't need a fix.

Fixes go into the newest version only, so please check that one if you can.

## What counts

agentbook-cli treats its server as something that can be broken into. So all of these are worth reporting:

- A server, or anything posing as one, getting a machine to run something its person's passkey didn't sign.
- A server reading or changing what the gate on a machine should keep it from: files outside the folders it shares, or the gate's own settings.
- Another user on the machine getting at its data or its token.

## What's known already

The README says what the gate doesn't stop, under [What it does on your machine](README.md#what-it-does-on-your-machine): shared folders can be read without a signature, a broken-into server could type in an open terminal for 30 minutes after a signature, the page that asks for your passkey comes from the server, and replacing secrets works by matching known shapes, so it can miss some. Getting past what those limits say is worth reporting. The limits themselves aren't news.
