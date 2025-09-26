import asyncio
import websockets
import random
import struct

SERVER = "ws://localhost:8080"

async def bot(name):
    async with websockets.connect(SERVER) as ws:
        while True:
            # random input
            dir = random.choice([0,1,2,3])
            msg = struct.pack("BB", 1, dir)  # type=1, direction
            await ws.send(msg)
            try:
                data = await asyncio.wait_for(ws.recv(), timeout=0.2)
                # parse only header
                t = data[0]
                if t == 2:
                    pass  # state update
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(0.2)

async def main():
    bots = [bot(f"bot{i}") for i in range(3)]
    await asyncio.gather(*bots)

if __name__ == "__main__":
    asyncio.run(main())
