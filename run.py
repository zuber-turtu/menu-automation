import uvicorn
from app.config import settings

if __name__ == "__main__":
    print(f"\n=======================================================")
    print(f"  {settings.PROJECT_NAME} (v{settings.VERSION})")
    print(f"  Access Dashboard at: http://{settings.HOST}:{settings.PORT}")
    print(f"=======================================================\n")
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
