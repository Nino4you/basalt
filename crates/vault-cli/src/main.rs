use std::io::{self, Read, Write};
use std::process::ExitCode;
use vault_core::{DirectoryVault, VaultPath, VaultStorage, search};

const USAGE: &str = "Usage: vault-cli <list|read|search|create> <vault-directory> [path-or-query]\n\
    create reads Markdown from stdin and never overwrites an existing file.";

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let valid = match args.first().map(String::as_str) {
        Some("list") => args.len() == 2,
        Some("read" | "search" | "create") => args.len() == 3,
        _ => false,
    };
    if !valid {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, USAGE));
    }
    let vault = DirectoryVault::open(&args[1])?;
    let mut output = io::stdout().lock();
    match args[0].as_str() {
        "list" => {
            for file in vault.document_files()? {
                writeln!(output, "{}", file.as_str())?;
            }
        }
        "read" => output.write_all(vault.read_text(&VaultPath::parse(&args[2])?)?.as_bytes())?,
        "search" => {
            for hit in search(&vault, &args[2])? {
                writeln!(output, "{}:{}:{}", hit.path.as_str(), hit.line, hit.preview)?;
            }
        }
        "create" => {
            let path = VaultPath::parse(&args[2])?;
            if !path.is_markdown() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "expected a .md path",
                ));
            }
            let mut text = String::new();
            io::stdin().read_to_string(&mut text)?;
            vault.create_text(&path, &text)?;
        }
        _ => unreachable!("validated command"),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("vault-cli: {error}");
            ExitCode::FAILURE
        }
    }
}
