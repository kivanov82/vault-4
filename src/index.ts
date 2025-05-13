import express from 'express';
import {MarketListener} from "./service/MarketListener";
import {TradingManager} from "./service/TradingManager";

const app = express();
const cors = require('cors');
const port = process.env.PORT || 3000;

app.use(express.json())                   //Express
    .use(cors())                            //CORS enabled
    //BigInt  serializer
    .use((req, res, next) => {
        res.json = (data) => {
            return res.send(JSON.stringify(data, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        };
        next();
    });;

app.get('/', (req, res) => {
    res.send('Welcome to Vault 3 API');
});


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    MarketListener.init();
    //TradingManager.test();
});

export default app;
