import * as React from 'react';
import './LeftTopNav.css';
import ComposeIcon from '../../../../../assets/icons/compose-icon.png';
import { BrowserRouter, Route, Link } from 'react-router-dom';

function LeftTopNav() {
    return (
        <div className="LeftTopNav-Set">
            <div id="leftTopSearch">
                <input id="messageSearch" type="text" name="search" placeholder="Search"></input>
            </div>
            <div id="leftTopButton">
                <Link id="newMessage" to="/">
                    <img id="composeIcon" src={ComposeIcon}></img>
                </Link>
            </div>
        </div>
    );
}

export default LeftTopNav;
