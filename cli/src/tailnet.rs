//! This machine on its Tailscale network, read from the `tailscale` command.
//!
//! A review is served on the machine's tailnet address beside loopback, so its
//! link opens on any of the user's devices. Who may open it is settled by
//! Tailscale itself: a tailnet address belongs to the one device whose
//! WireGuard key Tailscale authenticated, `tailscale whois` names that device's
//! account, and only devices of the account this machine is signed in to may
//! trade the review's link for a pass. A tagged server has no such account; any
//! device with its link gets in. Anything Tailscale says that can't be read
//! leaves the machine off the tailnet.

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

pub struct Machine {
    pub ip: Ipv4Addr,
    /// The MagicDNS name, without its final dot; the address without MagicDNS.
    pub name: String,
    /// The account the machine is signed in to; none when it is tagged.
    pub owner: Option<u64>,
    pub cli: PathBuf,
}

/// The `tailscale` command: on PATH, else inside the macOS app.
fn commands() -> impl Iterator<Item = PathBuf> {
    let app = cfg!(target_os = "macos").then(|| PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
    std::iter::once(PathBuf::from("tailscale")).chain(app)
}

/// What a `tailscale` command prints, unless it fails to start or hangs.
async fn run(cli: &PathBuf, args: &[&str]) -> Option<Vec<u8>> {
    let command =
        tokio::process::Command::new(cli).args(args).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).output();
    let output = tokio::time::timeout(Duration::from_secs(3), command).await.ok()?.ok()?;
    output.status.success().then_some(output.stdout)
}

/// This machine, when Tailscale is running and connected.
pub async fn find() -> Option<Machine> {
    for cli in commands() {
        if let Some(output) = run(&cli, &["status", "--json", "--peers=false"]).await {
            return parse_status(&output, cli);
        }
    }
    None
}

fn parse_status(json: &[u8], cli: PathBuf) -> Option<Machine> {
    let status: serde_json::Value = serde_json::from_slice(json).ok()?;
    if status.get("BackendState")?.as_str()? != "Running" {
        return None;
    }
    let me = status.get("Self")?;
    let ip = me.get("TailscaleIPs")?.as_array()?.iter().find_map(|ip| ip.as_str()?.parse::<Ipv4Addr>().ok())?;
    // Without MagicDNS other devices can't resolve the name.
    let magic = status.pointer("/CurrentTailnet/MagicDNSEnabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
    let name = if magic { me.get("DNSName")?.as_str()?.trim_end_matches('.').to_string() } else { ip.to_string() };
    // Only tags it names make a server; else it must name its account.
    let tagged = me.get("Tags").and_then(|tags| tags.as_array()).is_some_and(|tags| !tags.is_empty());
    let owner = if tagged { None } else { Some(me.get("UserID")?.as_u64().filter(|id| *id != 0)?) };
    (!name.is_empty()).then_some(Machine { ip, name, owner, cli })
}

/// Who a device on the tailnet belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Account {
    Person(u64),
    /// Owned by its tags, not by the account that tagged it.
    Tagged,
}

/// The account behind a tailnet address; none when Tailscale doesn't know it.
pub async fn account(cli: &PathBuf, ip: IpAddr) -> Option<Account> {
    parse_whois(&run(cli, &["whois", "--json", &ip.to_string()]).await?)
}

fn parse_whois(json: &[u8]) -> Option<Account> {
    let whois: serde_json::Value = serde_json::from_slice(json).ok()?;
    let tagged = whois.pointer("/Node/Tags").and_then(|tags| tags.as_array()).is_some_and(|tags| !tags.is_empty());
    if tagged {
        return Some(Account::Tagged);
    }
    whois.pointer("/UserProfile/ID")?.as_u64().map(Account::Person)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_machine_has_its_name_address_and_owner() {
        let status = br#"{"BackendState":"Running","Self":{"DNSName":"z.tail1.ts.net.","UserID":42,
            "TailscaleIPs":["fd7a:115c:a1e0::1","100.64.0.7"]}}"#;
        let machine = parse_status(status, "tailscale".into()).unwrap();
        assert_eq!(machine.name, "z.tail1.ts.net");
        assert_eq!(machine.ip, Ipv4Addr::new(100, 64, 0, 7));
        assert_eq!(machine.owner, Some(42));
    }

    #[test]
    fn a_tagged_machine_has_no_owner_and_a_stopped_one_is_not_found() {
        let tagged = br#"{"BackendState":"Running","Self":{"DNSName":"ci.tail1.ts.net.","UserID":42,
            "Tags":["tag:ci"],"TailscaleIPs":["100.64.0.8"]}}"#;
        assert_eq!(parse_status(tagged, "tailscale".into()).unwrap().owner, None);
        let stopped = br#"{"BackendState":"Stopped","Self":{"DNSName":"","TailscaleIPs":[]}}"#;
        assert!(parse_status(stopped, "tailscale".into()).is_none());
    }

    #[test]
    fn without_magic_dns_the_machine_goes_by_its_address() {
        let status = br#"{"BackendState":"Running","CurrentTailnet":{"MagicDNSEnabled":false},
            "Self":{"DNSName":"z.tail1.ts.net.","UserID":42,"TailscaleIPs":["100.64.0.7"]}}"#;
        assert_eq!(parse_status(status, "tailscale".into()).unwrap().name, "100.64.0.7");
    }

    #[test]
    fn an_untagged_machine_without_a_readable_owner_is_not_found() {
        for user in [r#""42""#, "0", "null"] {
            let status = format!(
                r#"{{"BackendState":"Running","Self":{{"DNSName":"z.tail1.ts.net.","UserID":{user},"TailscaleIPs":["100.64.0.7"]}}}}"#
            );
            assert!(parse_status(status.as_bytes(), "tailscale".into()).is_none(), "{user}");
        }
        let missing = br#"{"BackendState":"Running","Self":{"DNSName":"z.tail1.ts.net.","TailscaleIPs":["100.64.0.7"]}}"#;
        assert!(parse_status(missing, "tailscale".into()).is_none());
    }

    #[tokio::test]
    async fn a_failing_command_says_nothing() {
        assert_eq!(run(&"false".into(), &[]).await, None);
        assert_eq!(run(&"true".into(), &[]).await, Some(vec![]));
    }

    #[test]
    fn whois_names_a_person_and_never_a_tagged_device() {
        assert_eq!(parse_whois(br#"{"Node":{"Tags":null},"UserProfile":{"ID":42}}"#), Some(Account::Person(42)));
        assert_eq!(parse_whois(br#"{"Node":{"Tags":["tag:ci"]},"UserProfile":{"ID":42}}"#), Some(Account::Tagged));
        assert_eq!(parse_whois(b"peer not found"), None);
    }
}
