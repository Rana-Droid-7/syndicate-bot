name: Bug report
description: Something broke or behaves wrong
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description. Include the command (e.g. `>remindme "in 2 hours" test`) and what you expected instead.
      placeholder: "I ran >... and ..."
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Bot version (`>bot`)
      placeholder: "1.1.2"
  - type: dropdown
    id: surface
    attributes:
      label: Where did it happen?
      options:
        - Prefix command (>)
        - Slash command (/)
        - Buttons / menus on a bot message
        - Other / not sure
  - type: textarea
    id: logs
    attributes:
      label: Console/log output (if you operate the bot)
      description: Paste errors from the console. Never paste your bot token.
      render: shell
