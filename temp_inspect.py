import sqlite3
import os

base_dir = r"C:\Users\HP\.gemini\antigravity-cli"
db_path = os.path.join(base_dir, "conversation_summaries.db")

print("Checking conversation_summaries.db:")
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cur.fetchall()
    print("Tables:", tables)
    for (t_name,) in tables:
        cur.execute(f"PRAGMA table_info({t_name});")
        print(f"Schema of {t_name}:", cur.fetchall())
        cur.execute(f"SELECT * FROM {t_name} LIMIT 3;")
        print(f"Sample data from {t_name}:", cur.fetchall())
        cur.execute(f"SELECT COUNT(*) FROM {t_name};")
        print(f"Count of {t_name}:", cur.fetchone()[0])
    conn.close()

conv_dir = os.path.join(base_dir, "conversations")
conv_files = os.listdir(conv_dir)
print(f"\nTotal conversation files: {len(conv_files)}")
sample_dbs = [f for f in conv_files if f.endswith('.db')][:2]
for sample_db in sample_dbs:
    sample_path = os.path.join(conv_dir, sample_db)
    print(f"\nChecking sample conversation db: {sample_db}")
    try:
        conn = sqlite3.connect(sample_path)
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = cur.fetchall()
        print("Tables in sample db:", tables)
        for (t_name,) in tables:
            cur.execute(f"PRAGMA table_info({t_name});")
            print(f"Schema of {t_name}:", cur.fetchall())
            cur.execute(f"SELECT * FROM {t_name} LIMIT 1;")
            print(f"Sample data from {t_name}:", cur.fetchall())
        conn.close()
    except Exception as e:
        print("Error reading sample db:", e)
