@tool
extends EditorPlugin

## FolderForge Bridge - editor plugin entry point.
##
## Registers the runtime bridge autoload so that every game launched from this
## project starts a small TCP JSON server (default 127.0.0.1:9090) that the
## FolderForge MCP server talks to for the game_* RUN-channel tools.
##
## The heavy lifting lives in runtime_bridge.gd; this plugin only wires the
## autoload in/out when the addon is enabled/disabled in the editor.

const AUTOLOAD_NAME := "FolderForgeBridge"
const AUTOLOAD_PATH := "res://addons/folderforge_bridge/runtime_bridge.gd"


func _enter_tree() -> void:
	# Singleton autoload: present in every scene of the running game.
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _exit_tree() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
