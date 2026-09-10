pub mod virtual_workspace;

pub use virtual_workspace::{
    vfs_commit_to_disk_native, vfs_create_session_native, vfs_delete_file_native,
    vfs_destroy_session_native, vfs_generate_diff_native, vfs_list_modified_native,
    vfs_read_file_native, vfs_write_file_native, RsVfsFileStatus,
};
