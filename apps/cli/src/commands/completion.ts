import type { Command } from "commander";
import { buildBashCompletion, buildFishCompletion, buildZshCompletion, completionSpec } from "../completion";
import { CliError } from "../output";

const BUILDERS = { bash: buildBashCompletion, zsh: buildZshCompletion, fish: buildFishCompletion } as const;

export function registerCompletion(program: Command): void {
  program
    .command("completion <shell>")
    .description("print a shell completion script: bash, zsh, or fish")
    .addHelpText(
      "after",
      `
Install (file-based):
  bash:   mkdir -p ~/.local/share/bash-completion/completions \\
            && cctr completion bash > ~/.local/share/bash-completion/completions/cctr
  zsh:    mkdir -p ~/.zsh/completions && cctr completion zsh > ~/.zsh/completions/_cctr
          # then, in ~/.zshrc before compinit: fpath=(~/.zsh/completions $fpath)
  fish:   cctr completion fish > ~/.config/fish/completions/cctr.fish

Install (eval on shell init):
  bash:   echo 'source <(cctr completion bash)' >> ~/.bashrc
  zsh:    echo 'source <(cctr completion zsh)'  >> ~/.zshrc   # after compinit
  fish:   echo 'cctr completion fish | source'   >> ~/.config/fish/config.fish`,
    )
    .action((shell: string) => {
      if (!(shell in BUILDERS)) throw new CliError(`unsupported shell: ${shell} (expected bash, zsh, or fish)`, 2);
      process.stdout.write(BUILDERS[shell as keyof typeof BUILDERS](completionSpec(program, "cctr")));
    });
}
