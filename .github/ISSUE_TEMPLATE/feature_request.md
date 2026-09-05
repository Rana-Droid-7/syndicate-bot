name: Feature suggestion
description: Ideas for new commands or improvements
labels: ["enhancement"]
body:
  - type: textarea
    id: the-idea
    attributes:
      label: Your suggestion
      description: What should the bot do, and why is it useful? Prefix commands use `>` — structured ideas (`>suggest "..."`) also reach the maintainer.
      placeholder: "I'd like a command that ..."
    validations:
      required: true
  - type: input
    id: similar
    attributes:
      label: Similar bot / command you've seen (optional)
