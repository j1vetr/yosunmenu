module.exports = {
  apps: [
    {
      name: "yosunmenu",
      script: "node",
      args: "--enable-source-maps artifacts/api-server/dist/index.mjs",
      cwd: "/var/www/yosunmenu",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        PORT: "1081",
        DATABASE_URL: "postgresql://yosun_user:YosunMenu2024@localhost:5432/yosun_menu",
        SESSION_SECRET: "BURAYA_OPENSSL_CIKTISI_YAPISTIR",
        DEFAULT_OBJECT_STORAGE_BUCKET_ID: "",
        PRIVATE_OBJECT_DIR: "/var/www/yosunmenu/storage/private",
        PUBLIC_OBJECT_SEARCH_PATHS: "/var/www/yosunmenu/storage/public",
      },
    },
  ],
};
