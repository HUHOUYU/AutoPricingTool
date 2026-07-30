mod tests {
    use super::*;

    #[test]
    fn reads_action_or_legacy_command_field() {
        assert_eq!(command_action(&json!({"action": "scan"})), "scan");
        assert_eq!(command_action(&json!({"command": "start"})), "start");
        assert_eq!(
            command_action(&json!({"action": "pause", "command": "scan"})),
            "pause"
        );
        assert_eq!(command_action(&json!({})), "");
    }
}
